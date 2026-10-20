/*
 * ljs: the C layer shared by the Node-API addon and the WebAssembly build.
 *
 * Every compress/decompress loop lives here, once. Both bindings are thin
 * wrappers that move bytes in and out, so a fix or a test here covers both.
 *
 * Two formats:
 *   - the LZ4 frame format (lz4frame.h): self-describing, checksummed, what
 *     the lz4 command-line tool reads and writes. ljs_compress, ljs_decompress
 *     and the streams.
 *   - the raw LZ4 block format (lz4.h, lz4hc.h): no header, no checksum, no
 *     end marker. ljs_compress_block and ljs_decompress_block.
 *
 * Conventions:
 *   - Functions return LJS_OK (0) or an LJS_ERR_* code.
 *   - On error, *detail (when non-NULL) points to a static, NUL-terminated
 *     message. It is never freed and is safe to read from any thread.
 *   - Output is appended to a caller-owned ljs_buf, which the caller frees
 *     with ljs_buf_free (also on error).
 *   - Compression levels follow lz4frame: below 0 is the fast compressor with
 *     acceleration 1 - level, 0 and 1 are the fast compressor, and from
 *     LZ4HC_CLEVEL_MIN (2) up to 12 is LZ4 HC.
 */
#ifndef LJS_H
#define LJS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  LJS_OK = 0,
  LJS_ERR_LIBRARY = 1,      /* liblz4 rejected the data; detail says why */
  LJS_ERR_TRUNCATED = 2,    /* input ended before the end of a frame (or was empty) */
  LJS_ERR_OUTPUT_LIMIT = 3, /* decompressed size would exceed the limit */
  LJS_ERR_NOMEM = 4,        /* allocation failed */
  LJS_ERR_ARG = 5           /* invalid argument */
};

enum { LJS_MODE_CONTINUE = 0, LJS_MODE_FLUSH = 1, LJS_MODE_END = 2 };

/* Frame options, OR-ed together. */
enum {
  LJS_FLAG_CONTENT_CHECKSUM = 1, /* XXH32 of the whole content after the end mark */
  LJS_FLAG_BLOCK_CHECKSUM = 2,   /* XXH32 of each compressed block */
  LJS_FLAG_CONTENT_SIZE = 4      /* record the content size in the header (one-shot only) */
};

typedef struct ljs_buf {
  uint8_t* data;
  size_t size;
  size_t cap;
} ljs_buf;

void ljs_buf_free(ljs_buf* buf);

/*
 * One-shot compression of src into a single frame. block_size is the maximum
 * block size in bytes: 65536, 262144, 1048576 or 4194304. A content size of 0
 * cannot be recorded (the format reads 0 as "unknown").
 */
int ljs_compress(const uint8_t* src, size_t src_size, int level, int block_size,
                 int flags, const uint8_t* dict, size_t dict_size, ljs_buf* out,
                 const char** detail);

/*
 * One-shot decompression of every frame in src (concatenated and skippable
 * frames included). Fails with LJS_ERR_TRUNCATED unless src ends exactly at
 * the end of a frame. max_output = SIZE_MAX means no limit.
 */
int ljs_decompress(const uint8_t* src, size_t src_size, const uint8_t* dict,
                   size_t dict_size, size_t max_output, ljs_buf* out,
                   const char** detail);

typedef struct ljs_cstream ljs_cstream;
typedef struct ljs_dstream ljs_dstream;

/* flags must not include LJS_FLAG_CONTENT_SIZE: a stream never knows its size. */
int ljs_cstream_create(int level, int block_size, int flags, const uint8_t* dict,
                       size_t dict_size, ljs_cstream** stream, const char** detail);
/*
 * mode: LJS_MODE_CONTINUE, LJS_MODE_FLUSH (emit buffered data as a block) or
 * LJS_MODE_END (end of frame; a later push starts a new frame). The frame
 * header is written by the first push, so END alone gives a valid empty frame.
 */
int ljs_cstream_push(ljs_cstream* stream, const uint8_t* src, size_t src_size,
                     int mode, ljs_buf* out, const char** detail);
void ljs_cstream_free(ljs_cstream* stream);

/* The dictionary is copied. */
int ljs_dstream_create(const uint8_t* dict, size_t dict_size, size_t max_output,
                       ljs_dstream** stream, const char** detail);
/* Decodes all of src. Returns only once every byte decodable so far is in out. */
int ljs_dstream_push(ljs_dstream* stream, const uint8_t* src, size_t src_size,
                     ljs_buf* out, const char** detail);
/* Call at end of input: fails with LJS_ERR_TRUNCATED if a frame is unfinished. */
int ljs_dstream_finish(ljs_dstream* stream, const char** detail);
void ljs_dstream_free(ljs_dstream* stream);

/*
 * Content size declared by the first frame's header: -1 if not recorded, 0 for
 * a skippable frame. Validates the header checksum.
 */
int ljs_frame_content_size(const uint8_t* src, size_t src_size, double* size,
                           const char** detail);

/* Compresses src (at most LZ4_MAX_INPUT_SIZE bytes) into one raw block. */
int ljs_compress_block(const uint8_t* src, size_t src_size, int level,
                       const uint8_t* dict, size_t dict_size, ljs_buf* out,
                       const char** detail);

/*
 * Decodes one raw block. With exact != 0, size is the original size and any
 * other result is an error: shorter is LJS_ERR_TRUNCATED, longer is
 * LJS_ERR_OUTPUT_LIMIT. With exact == 0, size is an upper bound
 * (LJS_ERR_OUTPUT_LIMIT above it); a block cut right after a run of literals
 * then decodes to a shorter result, which the block format cannot detect.
 * size must be at most LZ4_MAX_INPUT_SIZE.
 */
int ljs_decompress_block(const uint8_t* src, size_t src_size, const uint8_t* dict,
                         size_t dict_size, size_t size, int exact, ljs_buf* out,
                         const char** detail);

const char* ljs_version(void);
int ljs_min_level(void);
int ljs_max_level(void);
int ljs_default_level(void);

#ifdef __cplusplus
}
#endif

#endif /* LJS_H */
