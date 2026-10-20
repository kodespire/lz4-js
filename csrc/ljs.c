#define LZ4F_STATIC_LINKING_ONLY /* LZ4F_getErrorCode */
#include "ljs.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include "lz4.h"
#include "lz4frame.h"
#include "lz4hc.h"

/* Upper bound for the first allocation when decompressing a frame. Content
 * sizes come from frame headers, which are untrusted, so we never allocate
 * more than this up front; the buffer grows as real output arrives. */
#define LJS_INITIAL_CAP_LIMIT ((size_t)64 << 20)

/* Fastest level. lz4frame turns a negative level into acceleration
 * 1 - level, and lz4.c caps acceleration at LZ4_ACCELERATION_MAX (65537),
 * which it does not export. */
#define LJS_MIN_LEVEL (-65536)
/* Level 1, the lz4 command-line default. 0 is the same compressor. */
#define LJS_DEFAULT_LEVEL 1

/* An LZ4 sequence costs at least one input byte per 255 output bytes, so a
 * valid block never decodes to more than 255 times its size. */
#define LJS_MAX_BLOCK_RATIO 255
/* Matches can only reach 64 KiB back, so only the end of a dictionary counts. */
#define LJS_DICT_WINDOW 65536

/* Pointer handed to liblz4 for empty input, so it never sees NULL. */
static const uint8_t ljs_empty = 0;

static int ljs_fail(int code, const char* message, const char** detail) {
  if (detail) *detail = message;
  return code;
}

/* LZ4F error names (e.g. "ERROR_frameType_unknown") rephrased for users. */
static const char* ljs_frame_message(size_t code) {
  switch (LZ4F_getErrorCode(code)) {
    case LZ4F_ERROR_frameType_unknown: return "not LZ4 frame data (unknown magic number)";
    case LZ4F_ERROR_headerVersion_wrong: return "unsupported frame version";
    case LZ4F_ERROR_reservedFlag_set: return "reserved bit set in frame header";
    case LZ4F_ERROR_maxBlockSize_invalid: return "invalid block size in frame header";
    case LZ4F_ERROR_headerChecksum_invalid: return "frame header checksum mismatch";
    case LZ4F_ERROR_blockChecksum_invalid: return "block checksum mismatch";
    case LZ4F_ERROR_contentChecksum_invalid: return "content checksum mismatch";
    case LZ4F_ERROR_decompressionFailed: return "corrupt compressed block";
    case LZ4F_ERROR_frameSize_wrong: return "decoded size does not match the frame header's content size";
    case LZ4F_ERROR_frameHeader_incomplete: return "frame header is incomplete";
    default: return LZ4F_getErrorName(code);
  }
}

static int ljs_frame_fail(size_t code, const char** detail) {
  if (LZ4F_getErrorCode(code) == LZ4F_ERROR_allocation_failed) {
    return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
  }
  return ljs_fail(LJS_ERR_LIBRARY, ljs_frame_message(code), detail);
}

void ljs_buf_free(ljs_buf* buf) {
  if (!buf) return;
  free(buf->data);
  buf->data = NULL;
  buf->size = 0;
  buf->cap = 0;
}

/* Ensures at least min_free bytes of spare capacity, growing by ~1.5x. */
static int ljs_buf_reserve(ljs_buf* buf, size_t min_free, const char** detail) {
  size_t need, cap;
  uint8_t* data;
  if (buf->cap - buf->size >= min_free) return LJS_OK;
  if (min_free > SIZE_MAX - buf->size) return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
  need = buf->size + min_free;
  cap = buf->cap + buf->cap / 2;
  if (cap < buf->cap || cap < need) cap = need;
  data = (uint8_t*)realloc(buf->data, cap);
  if (!data && cap != need) {
    cap = need;
    data = (uint8_t*)realloc(buf->data, cap);
  }
  if (!data) return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
  buf->data = data;
  buf->cap = cap;
  return LJS_OK;
}

static int ljs_valid_level(int level) {
  return level >= LJS_MIN_LEVEL && level <= LZ4F_compressionLevel_max();
}

static int ljs_frame_prefs(int level, int block_size, int flags, size_t content_size,
                           LZ4F_preferences_t* prefs, const char** detail) {
  LZ4F_preferences_t p = LZ4F_INIT_PREFERENCES;
  if (!ljs_valid_level(level)) return ljs_fail(LJS_ERR_ARG, "compression level out of range", detail);
  switch (block_size) {
    case 65536: p.frameInfo.blockSizeID = LZ4F_max64KB; break;
    case 262144: p.frameInfo.blockSizeID = LZ4F_max256KB; break;
    case 1048576: p.frameInfo.blockSizeID = LZ4F_max1MB; break;
    case 4194304: p.frameInfo.blockSizeID = LZ4F_max4MB; break;
    default: return ljs_fail(LJS_ERR_ARG, "block size must be 65536, 262144, 1048576 or 4194304", detail);
  }
  if (flags & ~(LJS_FLAG_CONTENT_CHECKSUM | LJS_FLAG_BLOCK_CHECKSUM | LJS_FLAG_CONTENT_SIZE)) {
    return ljs_fail(LJS_ERR_ARG, "invalid frame flags", detail);
  }
  /* Linked blocks: each block may refer to the previous 64 KiB, which
   * compresses better than independent blocks at no cost to the decoder. */
  p.frameInfo.blockMode = LZ4F_blockLinked;
  p.frameInfo.contentChecksumFlag =
      (flags & LJS_FLAG_CONTENT_CHECKSUM) ? LZ4F_contentChecksumEnabled : LZ4F_noContentChecksum;
  p.frameInfo.blockChecksumFlag =
      (flags & LJS_FLAG_BLOCK_CHECKSUM) ? LZ4F_blockChecksumEnabled : LZ4F_noBlockChecksum;
  p.frameInfo.contentSize = (flags & LJS_FLAG_CONTENT_SIZE) ? (unsigned long long)content_size : 0;
  p.compressionLevel = level;
  *prefs = p;
  return LJS_OK;
}

/* NULL dictionary when dict_size is 0. */
static int ljs_create_cdict(const uint8_t* dict, size_t dict_size, LZ4F_CDict** cdict,
                            const char** detail) {
  *cdict = NULL;
  if (dict_size == 0) return LJS_OK;
  *cdict = LZ4F_createCDict(dict, dict_size); /* copies the last 64 KiB */
  return *cdict ? LJS_OK : ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
}

int ljs_compress(const uint8_t* src, size_t src_size, int level, int block_size,
                 int flags, const uint8_t* dict, size_t dict_size, ljs_buf* out,
                 const char** detail) {
  LZ4F_preferences_t prefs;
  LZ4F_cctx* cctx = NULL;
  LZ4F_CDict* cdict = NULL;
  size_t bound, r;
  int rc;

  rc = ljs_frame_prefs(level, block_size, flags, src_size, &prefs, detail);
  if (rc != LJS_OK) return rc;
  bound = LZ4F_compressFrameBound(src_size, &prefs);
  if (bound < src_size) return ljs_fail(LJS_ERR_ARG, "input too large", detail);

  rc = ljs_create_cdict(dict, dict_size, &cdict, detail);
  if (rc != LJS_OK) return rc;
  r = LZ4F_createCompressionContext(&cctx, LZ4F_VERSION);
  if (LZ4F_isError(r)) rc = ljs_frame_fail(r, detail);
  if (rc == LJS_OK) rc = ljs_buf_reserve(out, bound, detail);
  if (rc == LJS_OK) {
    r = LZ4F_compressFrame_usingCDict(cctx, out->data + out->size, out->cap - out->size,
                                      src_size ? src : &ljs_empty, src_size, cdict, &prefs);
    if (LZ4F_isError(r)) {
      rc = ljs_frame_fail(r, detail);
    } else {
      out->size += r;
    }
  }
  LZ4F_freeCompressionContext(cctx);
  LZ4F_freeCDict(cdict);
  return rc;
}

/* ---- streaming compression --------------------------------------------- */

struct ljs_cstream {
  LZ4F_cctx* cctx;
  LZ4F_CDict* cdict;
  LZ4F_preferences_t prefs;
  size_t block_size;
  int started; /* frame header written, frame not yet ended */
  int failed;  /* an LZ4F call failed, which leaves the context unusable */
};

int ljs_cstream_create(int level, int block_size, int flags, const uint8_t* dict,
                       size_t dict_size, ljs_cstream** stream, const char** detail) {
  ljs_cstream* s;
  size_t r;
  int rc;
  *stream = NULL;
  if (flags & LJS_FLAG_CONTENT_SIZE) {
    return ljs_fail(LJS_ERR_ARG, "a stream cannot record the content size", detail);
  }
  s = (ljs_cstream*)calloc(1, sizeof(*s));
  if (!s) return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
  rc = ljs_frame_prefs(level, block_size, flags, 0, &s->prefs, detail);
  if (rc == LJS_OK) rc = ljs_create_cdict(dict, dict_size, &s->cdict, detail);
  if (rc == LJS_OK) {
    r = LZ4F_createCompressionContext(&s->cctx, LZ4F_VERSION);
    if (LZ4F_isError(r)) rc = ljs_frame_fail(r, detail);
  }
  if (rc != LJS_OK) {
    ljs_cstream_free(s);
    return rc;
  }
  s->block_size = (size_t)block_size;
  *stream = s;
  return LJS_OK;
}

/* Reserves `need` bytes, runs one LZ4F call into them and appends its output. */
#define LJS_CSTREAM_CALL(need, call)                                   \
  do {                                                                 \
    size_t r_;                                                         \
    rc = ljs_buf_reserve(out, (need), detail);                         \
    if (rc != LJS_OK) return rc;                                       \
    r_ = (call);                                                       \
    if (LZ4F_isError(r_)) {                                            \
      stream->failed = 1;                                              \
      return ljs_frame_fail(r_, detail);                               \
    }                                                                  \
    out->size += r_;                                                   \
  } while (0)

int ljs_cstream_push(ljs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, ljs_buf* out, const char** detail) {
  size_t pos = 0;
  int rc;

  if (!stream || !stream->cctx) return ljs_fail(LJS_ERR_ARG, "stream is closed", detail);
  if (stream->failed) return ljs_fail(LJS_ERR_ARG, "stream failed earlier and cannot be used", detail);
  if (mode != LJS_MODE_CONTINUE && mode != LJS_MODE_FLUSH && mode != LJS_MODE_END) {
    return ljs_fail(LJS_ERR_ARG, "invalid stream mode", detail);
  }

  if (!stream->started) {
    LJS_CSTREAM_CALL(LZ4F_HEADER_SIZE_MAX,
                     LZ4F_compressBegin_usingCDict(stream->cctx, out->data + out->size,
                                                   out->cap - out->size, stream->cdict,
                                                   &stream->prefs));
    stream->started = 1;
  }
  /* LZ4F_compressUpdate needs room for its worst case up front, so feed it
   * one block at a time rather than reserving the bound of a huge chunk. */
  while (pos < src_size) {
    size_t n = src_size - pos < stream->block_size ? src_size - pos : stream->block_size;
    LJS_CSTREAM_CALL(LZ4F_compressBound(n, &stream->prefs),
                     LZ4F_compressUpdate(stream->cctx, out->data + out->size,
                                         out->cap - out->size, src + pos, n, NULL));
    pos += n;
  }
  if (mode == LJS_MODE_FLUSH) {
    LJS_CSTREAM_CALL(LZ4F_compressBound(0, &stream->prefs),
                     LZ4F_flush(stream->cctx, out->data + out->size, out->cap - out->size, NULL));
  } else if (mode == LJS_MODE_END) {
    LJS_CSTREAM_CALL(LZ4F_compressBound(0, &stream->prefs),
                     LZ4F_compressEnd(stream->cctx, out->data + out->size, out->cap - out->size,
                                      NULL));
    stream->started = 0;
  }
  return LJS_OK;
}

#undef LJS_CSTREAM_CALL

void ljs_cstream_free(ljs_cstream* stream) {
  if (!stream) return;
  LZ4F_freeCompressionContext(stream->cctx);
  LZ4F_freeCDict(stream->cdict);
  free(stream);
}

/* ---- streaming decompression ------------------------------------------- */

struct ljs_dstream {
  LZ4F_dctx* dctx;
  /* Our own copy: LZ4F reads the dictionary in place, at the start of every
   * frame, so it must outlive the caller's buffer. */
  uint8_t* dict;
  size_t dict_size;
  size_t max_output;
  size_t total_out;
  /* Last LZ4F_decompress() result from a call that made progress. 0 means
   * "at a frame boundary"; anything else means a frame is open or no frame
   * has been seen yet (empty input is not a valid LZ4 stream). */
  size_t last_ret;
  int seen_input;
  int failed; /* after an error the context is not resumable */
};

int ljs_dstream_create(const uint8_t* dict, size_t dict_size, size_t max_output,
                       ljs_dstream** stream, const char** detail) {
  ljs_dstream* s;
  size_t r;
  *stream = NULL;
  s = (ljs_dstream*)calloc(1, sizeof(*s));
  if (!s) return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
  r = LZ4F_createDecompressionContext(&s->dctx, LZ4F_VERSION);
  if (LZ4F_isError(r)) {
    ljs_dstream_free(s);
    return ljs_frame_fail(r, detail);
  }
  if (dict_size > LJS_DICT_WINDOW) {
    dict += dict_size - LJS_DICT_WINDOW;
    dict_size = LJS_DICT_WINDOW;
  }
  if (dict_size > 0) {
    s->dict = (uint8_t*)malloc(dict_size);
    if (!s->dict) {
      ljs_dstream_free(s);
      return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
    }
    memcpy(s->dict, dict, dict_size);
    s->dict_size = dict_size;
  }
  s->max_output = max_output;
  s->last_ret = 1;
  *stream = s;
  return LJS_OK;
}

int ljs_dstream_push(ljs_dstream* stream, const uint8_t* src, size_t src_size,
                     ljs_buf* out, const char** detail) {
  size_t pos = 0;
  int rc;

  if (!stream || !stream->dctx) return ljs_fail(LJS_ERR_ARG, "stream is closed", detail);
  if (stream->failed) return ljs_fail(LJS_ERR_ARG, "stream failed earlier and cannot be used", detail);
  if (src_size) stream->seen_input = 1;

  for (;;) {
    size_t r, offered, written, consumed, allowed;

    if (out->size == out->cap) {
      rc = ljs_buf_reserve(out, 65536, detail);
      if (rc != LJS_OK) return rc;
    }
    /* Never let liblz4 write more than one byte past the limit: that byte is
     * how we detect "too big" without decoding the rest. */
    allowed = stream->max_output - stream->total_out;
    if (allowed < SIZE_MAX) allowed += 1;

    offered = out->cap - out->size;
    if (offered > allowed) offered = allowed;
    written = offered;
    consumed = src_size - pos;
    /* With a dictionary, every call goes through _usingDict: LZ4F forgets the
     * dictionary at the end of each frame and takes it again at the next. */
    if (stream->dict) {
      r = LZ4F_decompress_usingDict(stream->dctx, out->data + out->size, &written,
                                    src_size ? src + pos : &ljs_empty, &consumed,
                                    stream->dict, stream->dict_size, NULL);
    } else {
      r = LZ4F_decompress(stream->dctx, out->data + out->size, &written,
                          src_size ? src + pos : &ljs_empty, &consumed, NULL);
    }
    if (LZ4F_isError(r)) {
      stream->failed = 1;
      return ljs_frame_fail(r, detail);
    }

    out->size += written;
    stream->total_out += written;
    pos += consumed;
    if (stream->total_out > stream->max_output) {
      stream->failed = 1;
      return ljs_fail(LJS_ERR_OUTPUT_LIMIT, "decompressed size exceeds maxOutputSize", detail);
    }
    if (written > 0 || consumed > 0) stream->last_ret = r;

    if (pos == src_size) {
      /* r == 0: frame fully decoded and flushed. written < offered: liblz4
       * had room left, so it flushed everything it could. Either way nothing
       * is held back. If the output filled up exactly, loop to drain it. */
      if (r == 0 || written < offered) break;
    } else if (written == 0 && consumed == 0) {
      stream->failed = 1;
      return ljs_fail(LJS_ERR_LIBRARY, "lz4 decoder made no progress", detail);
    }
  }
  return LJS_OK;
}

int ljs_dstream_finish(ljs_dstream* stream, const char** detail) {
  if (!stream || !stream->dctx) return ljs_fail(LJS_ERR_ARG, "stream is closed", detail);
  if (stream->failed) return ljs_fail(LJS_ERR_ARG, "stream failed earlier and cannot be used", detail);
  if (stream->last_ret != 0) {
    return ljs_fail(LJS_ERR_TRUNCATED,
                    stream->seen_input ? "lz4 input ended before the end of a frame"
                                       : "lz4 input is empty",
                    detail);
  }
  return LJS_OK;
}

void ljs_dstream_free(ljs_dstream* stream) {
  if (!stream) return;
  LZ4F_freeDecompressionContext(stream->dctx);
  free(stream->dict);
  free(stream);
}

static uint32_t ljs_read_le32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* Content size from the first frame header, unchecked, or 0 if absent. Only
 * a sizing hint: the decoder validates the header itself. */
static unsigned long long ljs_declared_size(const uint8_t* src, size_t src_size) {
  unsigned long long n = 0;
  int i;
  if (src_size < 14 || ljs_read_le32(src) != LZ4F_MAGICNUMBER || !(src[4] & 0x08)) return 0;
  for (i = 7; i >= 0; i--) n = (n << 8) | src[6 + i];
  return n;
}

int ljs_decompress(const uint8_t* src, size_t src_size, const uint8_t* dict,
                   size_t dict_size, size_t max_output, ljs_buf* out,
                   const char** detail) {
  ljs_dstream* s;
  unsigned long long declared;
  size_t hint;
  int rc;

  rc = ljs_dstream_create(dict, dict_size, max_output, &s, detail);
  if (rc != LJS_OK) return rc;

  /* Size the first allocation from the header when it declares a content
   * size (exact for a single well-formed frame), otherwise from the input
   * size. Capped, because headers can lie. */
  declared = ljs_declared_size(src, src_size);
  if (declared > 0) {
    hint = declared > LJS_INITIAL_CAP_LIMIT ? LJS_INITIAL_CAP_LIMIT : (size_t)declared;
  } else {
    hint = src_size > LJS_INITIAL_CAP_LIMIT / 4 ? LJS_INITIAL_CAP_LIMIT : src_size * 4;
    if (hint < 65536) hint = 65536;
  }
  if (max_output < SIZE_MAX && hint > max_output + 1) hint = max_output + 1;
  if (hint > 0 && ljs_buf_reserve(out, hint, detail) != LJS_OK) {
    /* Not fatal: start small and let real output drive growth. */
    if (detail) *detail = NULL;
  }

  rc = ljs_dstream_push(s, src, src_size, out, detail);
  if (rc == LJS_OK) rc = ljs_dstream_finish(s, detail);
  ljs_dstream_free(s);
  return rc;
}

int ljs_frame_content_size(const uint8_t* src, size_t src_size, double* size,
                           const char** detail) {
  LZ4F_dctx* dctx = NULL;
  LZ4F_frameInfo_t info;
  size_t consumed = src_size;
  size_t r = LZ4F_createDecompressionContext(&dctx, LZ4F_VERSION);
  if (LZ4F_isError(r)) return ljs_frame_fail(r, detail);
  r = LZ4F_getFrameInfo(dctx, &info, src_size ? src : &ljs_empty, &consumed);
  LZ4F_freeDecompressionContext(dctx);
  if (LZ4F_isError(r)) {
    LZ4F_errorCodes code = LZ4F_getErrorCode(r);
    if (code == LZ4F_ERROR_frameType_unknown || code == LZ4F_ERROR_frameHeader_incomplete) {
      return ljs_fail(LJS_ERR_ARG, "not an LZ4 frame, or the header is incomplete", detail);
    }
    return ljs_frame_fail(r, detail);
  }
  if (info.frameType == LZ4F_skippableFrame) {
    *size = 0;
  } else {
    *size = info.contentSize == 0 ? -1.0 : (double)info.contentSize;
  }
  return LJS_OK;
}

/* ---- raw blocks ----------------------------------------------------------- */

int ljs_compress_block(const uint8_t* src, size_t src_size, int level,
                       const uint8_t* dict, size_t dict_size, ljs_buf* out,
                       const char** detail) {
  const char* in = src_size ? (const char*)src : (const char*)&ljs_empty;
  const char* d = (const char*)dict;
  char* dst;
  int bound, n = 0;
  int rc;

  if (!ljs_valid_level(level)) return ljs_fail(LJS_ERR_ARG, "compression level out of range", detail);
  if (src_size > LZ4_MAX_INPUT_SIZE) {
    return ljs_fail(LJS_ERR_ARG, "input too large for one LZ4 block (at most 2113929216 bytes)", detail);
  }
  if (dict_size > LJS_DICT_WINDOW) {
    d += dict_size - LJS_DICT_WINDOW;
    dict_size = LJS_DICT_WINDOW;
  }
  bound = LZ4_compressBound((int)src_size);
  rc = ljs_buf_reserve(out, (size_t)bound, detail);
  if (rc != LJS_OK) return rc;
  dst = (char*)(out->data + out->size);

  /* Same split as lz4frame, so a level means the same thing in both formats. */
  if (level < LZ4HC_CLEVEL_MIN) {
    int acceleration = level < 0 ? 1 - level : 1;
    if (dict_size > 0) {
      LZ4_stream_t* state = LZ4_createStream();
      if (!state) return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
      LZ4_loadDictSlow(state, d, (int)dict_size);
      n = LZ4_compress_fast_continue(state, in, dst, (int)src_size, bound, acceleration);
      LZ4_freeStream(state);
    } else {
      n = LZ4_compress_fast(in, dst, (int)src_size, bound, acceleration);
    }
  } else {
    if (dict_size > 0) {
      LZ4_streamHC_t* state = LZ4_createStreamHC();
      if (!state) return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
      LZ4_resetStreamHC_fast(state, level); /* the level must be set before loading */
      LZ4_loadDictHC(state, d, (int)dict_size);
      n = LZ4_compress_HC_continue(state, in, dst, (int)src_size, bound);
      LZ4_freeStreamHC(state);
    } else {
      n = LZ4_compress_HC(in, dst, (int)src_size, bound, level);
    }
  }
  /* With dstCapacity >= LZ4_compressBound, only an allocation can fail. */
  if (n <= 0) return ljs_fail(LJS_ERR_NOMEM, "out of memory", detail);
  out->size += (size_t)n;
  return LJS_OK;
}

/* LZ4_decompress_safe*, or with target > 0, LZ4_decompress_safe_partial*. */
static int ljs_decode_block(const uint8_t* src, size_t src_size, const uint8_t* dict,
                            size_t dict_size, uint8_t* dst, size_t cap, size_t target) {
  const char* in = (const char*)src;
  char* o = (char*)dst;
  if (target > 0) {
    return dict_size > 0
               ? LZ4_decompress_safe_partial_usingDict(in, o, (int)src_size, (int)target, (int)cap,
                                                       (const char*)dict, (int)dict_size)
               : LZ4_decompress_safe_partial(in, o, (int)src_size, (int)target, (int)cap);
  }
  return dict_size > 0 ? LZ4_decompress_safe_usingDict(in, o, (int)src_size, (int)cap,
                                                       (const char*)dict, (int)dict_size)
                       : LZ4_decompress_safe(in, o, (int)src_size, (int)cap);
}

int ljs_decompress_block(const uint8_t* src, size_t src_size, const uint8_t* dict,
                         size_t dict_size, size_t size, int exact, ljs_buf* out,
                         const char** detail) {
  size_t bound, ceiling, cap;
  int rc;

  if (size > LZ4_MAX_INPUT_SIZE) {
    return ljs_fail(LJS_ERR_ARG, "block size limit must be at most 2113929216 bytes", detail);
  }
  if (src_size == 0) return ljs_fail(LJS_ERR_TRUNCATED, "lz4 block is empty", detail);
  if (src_size > INT_MAX) return ljs_fail(LJS_ERR_ARG, "input too large for one LZ4 block", detail);
  if (dict_size > LJS_DICT_WINDOW) {
    dict += dict_size - LJS_DICT_WINDOW;
    dict_size = LJS_DICT_WINDOW;
  }

  /* The most any valid block of this size can decode to. Also guards the
   * allocation against a huge size passed for a tiny block. */
  bound = src_size > LZ4_MAX_INPUT_SIZE / LJS_MAX_BLOCK_RATIO ? (size_t)LZ4_MAX_INPUT_SIZE
                                                              : src_size * LJS_MAX_BLOCK_RATIO;
  if (exact) {
    if (size > bound) {
      return ljs_fail(LJS_ERR_TRUNCATED, "lz4 block is too short to decode to originalSize bytes", detail);
    }
    ceiling = cap = size;
  } else {
    /* Start near a typical ratio and grow, rather than allocating the limit:
     * WebAssembly memory never shrinks. */
    ceiling = size < bound ? size : bound;
    cap = src_size > ceiling / 4 ? ceiling : src_size * 4;
    if (cap < 65536) cap = 65536 < ceiling ? 65536 : ceiling;
  }

  for (;;) {
    uint8_t* dst;
    int n;
    /* One spare byte for the probe below. */
    rc = ljs_buf_reserve(out, cap + 1, detail);
    if (rc != LJS_OK) return rc;
    dst = out->data + out->size;

    n = ljs_decode_block(src, src_size, dict, dict_size, dst, cap, 0);
    if (n >= 0) {
      if (exact && (size_t)n != size) {
        return ljs_fail(LJS_ERR_TRUNCATED,
                        "lz4 block decoded to fewer bytes than originalSize (truncated block, or wrong originalSize)",
                        detail);
      }
      out->size += (size_t)n;
      return LJS_OK;
    }
    /* Corrupt, or the output does not fit in cap. Partial decoding tolerates
     * cut-off input, so it only answers "is there more than cap bytes?" and
     * never produces the result. */
    if (cap >= bound ||
        ljs_decode_block(src, src_size, dict, dict_size, dst, cap + 1, cap + 1) != (int)(cap + 1)) {
      return ljs_fail(LJS_ERR_LIBRARY, "corrupt lz4 block", detail);
    }
    if (cap >= size) {
      return ljs_fail(LJS_ERR_OUTPUT_LIMIT,
                      exact ? "lz4 block decodes to more than originalSize bytes"
                            : "decompressed size exceeds maxOutputSize",
                      detail);
    }
    cap = cap > ceiling / 4 ? ceiling : cap * 4;
  }
}

const char* ljs_version(void) { return LZ4_versionString(); }
int ljs_min_level(void) { return LJS_MIN_LEVEL; }
int ljs_max_level(void) { return LZ4F_compressionLevel_max(); }
int ljs_default_level(void) { return LJS_DEFAULT_LEVEL; }
