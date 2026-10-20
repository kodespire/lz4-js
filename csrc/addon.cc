// Node-API binding. Moves bytes between JavaScript and the ljs C layer; all
// compression logic lives in ljs.c.
//
// Errors are thrown (or rejected) as Error objects carrying a numeric
// `ljsCode` property; the TypeScript layer turns them into Lz4Error.

#include <napi.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "ljs.h"

namespace {

Napi::Error MakeError(Napi::Env env, int code, const char* detail) {
  Napi::Error error = Napi::Error::New(env, detail ? detail : "lz4 error");
  error.Value().Set("ljsCode", Napi::Number::New(env, code));
  return error;
}

// Hands an ljs_buf to JavaScript without copying when the runtime allows
// external buffers, and copies otherwise (e.g. Electron's V8 sandbox).
// Leaves `buf` empty either way.
Napi::Buffer<uint8_t> TakeBuffer(Napi::Env env, ljs_buf* buf) {
  if (buf->size == 0) {
    ljs_buf_free(buf);
    return Napi::Buffer<uint8_t>::New(env, 0);
  }
  if (buf->cap - buf->size > 4096) {
    void* shrunk = realloc(buf->data, buf->size);
    if (shrunk) {
      buf->data = static_cast<uint8_t*>(shrunk);
      buf->cap = buf->size;
    }
  }
  uint8_t* data = buf->data;
  size_t size = buf->size;
  buf->data = nullptr;
  buf->size = 0;
  buf->cap = 0;
  return Napi::Buffer<uint8_t>::NewOrCopy(env, data, size,
                                          [](Napi::Env, uint8_t* p) { free(p); });
}

Napi::Uint8Array BytesArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  Napi::Value v = info[index];
  if (!v.IsTypedArray() || v.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a Uint8Array");
  }
  return v.As<Napi::Uint8Array>();
}

std::vector<uint8_t> CopyBytes(const Napi::Uint8Array& a) {
  return std::vector<uint8_t>(a.Data(), a.Data() + a.ByteLength());
}

// Optional Uint8Array: null/undefined -> empty.
std::vector<uint8_t> OptionalBytesCopy(const Napi::CallbackInfo& info, size_t index, const char* name) {
  Napi::Value v = info[index];
  if (v.IsNull() || v.IsUndefined()) return {};
  return CopyBytes(BytesArg(info, index, name));
}

int32_t IntArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  return info[index].As<Napi::Number>().Int32Value();
}

bool BoolArg(const Napi::CallbackInfo& info, size_t index) {
  return info[index].ToBoolean().Value();
}

// Number -> size_t limit. Infinity (and anything >= SIZE_MAX) means no limit.
size_t LimitArg(const Napi::CallbackInfo& info, size_t index, const char* name) {
  if (!info[index].IsNumber()) {
    throw Napi::TypeError::New(info.Env(), std::string(name) + " must be a number");
  }
  double d = info[index].As<Napi::Number>().DoubleValue();
  if (std::isnan(d) || d < 0) {
    throw Napi::RangeError::New(info.Env(), std::string(name) + " must be a non-negative number");
  }
  if (std::isinf(d) || d >= static_cast<double>(SIZE_MAX)) return SIZE_MAX;
  return static_cast<size_t>(d);
}

const uint8_t* DataOrNull(const std::vector<uint8_t>& v) {
  return v.empty() ? nullptr : v.data();
}

// ---- async one-shot ------------------------------------------------------

// Runs one ljs call on the libuv thread pool and resolves with its output.
class BufferWorker : public Napi::AsyncWorker {
 public:
  using Job = std::function<int(ljs_buf* out, const char** detail)>;

  BufferWorker(Napi::Env env, Job job, std::function<void()> done = nullptr)
      : Napi::AsyncWorker(env, "lz4-js"),
        deferred_(Napi::Promise::Deferred::New(env)),
        job_(std::move(job)),
        done_(std::move(done)) {}
  ~BufferWorker() override { ljs_buf_free(&out_); }

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  void Execute() override { rc_ = job_(&out_, &detail_); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    if (done_) done_();
    if (rc_ != LJS_OK) {
      deferred_.Reject(MakeError(env, rc_, detail_).Value());
    } else {
      deferred_.Resolve(TakeBuffer(env, &out_));
    }
  }

  void OnError(const Napi::Error& e) override {
    if (done_) done_();
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  Job job_;
  std::function<void()> done_;
  ljs_buf out_{};
  int rc_ = LJS_OK;
  const char* detail_ = nullptr;
};

// Runs job now and returns its output, or throws.
Napi::Value RunSync(Napi::Env env, const BufferWorker::Job& job) {
  ljs_buf out{};
  const char* detail = nullptr;
  int rc = job(&out, &detail);
  if (rc != LJS_OK) {
    ljs_buf_free(&out);
    throw MakeError(env, rc, detail);
  }
  return TakeBuffer(env, &out);
}

Napi::Value RunAsync(Napi::Env env, BufferWorker::Job job) {
  auto* worker = new BufferWorker(env, std::move(job));
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

// Async jobs own copies of their inputs: JavaScript may modify or transfer
// (detach) the source ArrayBuffer while the worker runs on another thread.
// Sync jobs read the caller's memory directly.

// compressSync / compress(data, level, blockSize, flags, dict | null)
BufferWorker::Job CompressJob(const Napi::CallbackInfo& info, bool copy) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int level = IntArg(info, 1, "level");
  int block_size = IntArg(info, 2, "blockSize");
  int flags = IntArg(info, 3, "flags");
  auto dict = std::make_shared<std::vector<uint8_t>>(OptionalBytesCopy(info, 4, "dictionary"));
  if (copy) {
    auto data = std::make_shared<std::vector<uint8_t>>(CopyBytes(src));
    return [=](ljs_buf* out, const char** detail) {
      return ljs_compress(DataOrNull(*data), data->size(), level, block_size, flags,
                          DataOrNull(*dict), dict->size(), out, detail);
    };
  }
  const uint8_t* p = src.Data();
  size_t n = src.ByteLength();
  return [=](ljs_buf* out, const char** detail) {
    return ljs_compress(p, n, level, block_size, flags, DataOrNull(*dict), dict->size(), out, detail);
  };
}

// decompressSync / decompress(data, dict | null, maxOutput)
BufferWorker::Job DecompressJob(const Napi::CallbackInfo& info, bool copy) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  auto dict = std::make_shared<std::vector<uint8_t>>(OptionalBytesCopy(info, 1, "dictionary"));
  size_t max_output = LimitArg(info, 2, "maxOutputSize");
  if (copy) {
    auto data = std::make_shared<std::vector<uint8_t>>(CopyBytes(src));
    return [=](ljs_buf* out, const char** detail) {
      return ljs_decompress(DataOrNull(*data), data->size(), DataOrNull(*dict), dict->size(),
                            max_output, out, detail);
    };
  }
  const uint8_t* p = src.Data();
  size_t n = src.ByteLength();
  return [=](ljs_buf* out, const char** detail) {
    return ljs_decompress(p, n, DataOrNull(*dict), dict->size(), max_output, out, detail);
  };
}

// compressBlockSync / compressBlock(data, level, dict | null)
BufferWorker::Job CompressBlockJob(const Napi::CallbackInfo& info, bool copy) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  int level = IntArg(info, 1, "level");
  auto dict = std::make_shared<std::vector<uint8_t>>(OptionalBytesCopy(info, 2, "dictionary"));
  if (copy) {
    auto data = std::make_shared<std::vector<uint8_t>>(CopyBytes(src));
    return [=](ljs_buf* out, const char** detail) {
      return ljs_compress_block(DataOrNull(*data), data->size(), level, DataOrNull(*dict),
                                dict->size(), out, detail);
    };
  }
  const uint8_t* p = src.Data();
  size_t n = src.ByteLength();
  return [=](ljs_buf* out, const char** detail) {
    return ljs_compress_block(p, n, level, DataOrNull(*dict), dict->size(), out, detail);
  };
}

// decompressBlockSync / decompressBlock(data, dict | null, size, exact)
BufferWorker::Job DecompressBlockJob(const Napi::CallbackInfo& info, bool copy) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  auto dict = std::make_shared<std::vector<uint8_t>>(OptionalBytesCopy(info, 1, "dictionary"));
  size_t size = LimitArg(info, 2, "size");
  int exact = BoolArg(info, 3) ? 1 : 0;
  if (copy) {
    auto data = std::make_shared<std::vector<uint8_t>>(CopyBytes(src));
    return [=](ljs_buf* out, const char** detail) {
      return ljs_decompress_block(DataOrNull(*data), data->size(), DataOrNull(*dict), dict->size(),
                                  size, exact, out, detail);
    };
  }
  const uint8_t* p = src.Data();
  size_t n = src.ByteLength();
  return [=](ljs_buf* out, const char** detail) {
    return ljs_decompress_block(p, n, DataOrNull(*dict), dict->size(), size, exact, out, detail);
  };
}

Napi::Value CompressSync(const Napi::CallbackInfo& info) { return RunSync(info.Env(), CompressJob(info, false)); }
Napi::Value Compress(const Napi::CallbackInfo& info) { return RunAsync(info.Env(), CompressJob(info, true)); }
Napi::Value DecompressSync(const Napi::CallbackInfo& info) { return RunSync(info.Env(), DecompressJob(info, false)); }
Napi::Value Decompress(const Napi::CallbackInfo& info) { return RunAsync(info.Env(), DecompressJob(info, true)); }
Napi::Value CompressBlockSync(const Napi::CallbackInfo& info) { return RunSync(info.Env(), CompressBlockJob(info, false)); }
Napi::Value CompressBlock(const Napi::CallbackInfo& info) { return RunAsync(info.Env(), CompressBlockJob(info, true)); }
Napi::Value DecompressBlockSync(const Napi::CallbackInfo& info) { return RunSync(info.Env(), DecompressBlockJob(info, false)); }
Napi::Value DecompressBlock(const Napi::CallbackInfo& info) { return RunAsync(info.Env(), DecompressBlockJob(info, true)); }

// frameContentSize(data): number (-1 when the header does not record it)
Napi::Value FrameContentSize(const Napi::CallbackInfo& info) {
  Napi::Uint8Array src = BytesArg(info, 0, "data");
  double size = 0;
  const char* detail = nullptr;
  int rc = ljs_frame_content_size(src.Data(), src.ByteLength(), &size, &detail);
  if (rc != LJS_OK) throw MakeError(info.Env(), rc, detail);
  return Napi::Number::New(info.Env(), size);
}

// ---- streams ---------------------------------------------------------------

// Shared by CStream and DStream: one operation at a time, and the JS object
// stays referenced while a worker uses the native context, so the garbage
// collector cannot free the context underneath it. T provides FreeContext()
// and a static Job(ctx, src, size, mode, out, detail).
template <typename T>
class StreamBase : public Napi::ObjectWrap<T> {
 public:
  using Napi::ObjectWrap<T>::ObjectWrap;

 protected:
  void Acquire(Napi::Env env) {
    if (closed_) throw MakeError(env, LJS_ERR_ARG, "stream is closed");
    if (busy_) throw MakeError(env, LJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    busy_ = true;
  }
  void Release() {
    busy_ = false;
    if (closed_) static_cast<T*>(this)->FreeContext();
  }

  // push(chunk[, mode]): Buffer
  Napi::Value PushSync(const Napi::CallbackInfo& info, int mode) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    ljs_buf out{};
    const char* detail = nullptr;
    int rc = T::Job(static_cast<T*>(this)->Context(), chunk.Data(), chunk.ByteLength(), mode, &out,
                    &detail);
    Release();
    if (rc != LJS_OK) {
      ljs_buf_free(&out);
      throw MakeError(info.Env(), rc, detail);
    }
    return TakeBuffer(info.Env(), &out);
  }

  // pushAsync(chunk[, mode]): Promise<Buffer>
  Napi::Value PushAsync(const Napi::CallbackInfo& info, int mode) {
    Napi::Uint8Array chunk = BytesArg(info, 0, "chunk");
    Acquire(info.Env());
    auto data = std::make_shared<std::vector<uint8_t>>(CopyBytes(chunk));
    auto* ctx = static_cast<T*>(this)->Context();
    auto owner = std::make_shared<Napi::ObjectReference>(Napi::Persistent(info.This().As<Napi::Object>()));
    auto* worker = new BufferWorker(
        info.Env(),
        [=](ljs_buf* out, const char** detail) {
          return T::Job(ctx, DataOrNull(*data), data->size(), mode, out, detail);
        },
        [this, owner]() {
          Release();
          owner->Reset();
        });
    Napi::Promise promise = worker->Promise();
    worker->Queue();
    return promise;
  }

  // close(): frees the context now, or as soon as an in-flight push finishes
  // (a stream cancelled mid-push, e.g. an aborted fetch, must not throw).
  Napi::Value Close(const Napi::CallbackInfo& info) {
    closed_ = true;
    if (!busy_) static_cast<T*>(this)->FreeContext();
    return info.Env().Undefined();
  }

  bool busy_ = false;
  bool closed_ = false;
};

class CStream : public StreamBase<CStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "CStream",
                       {InstanceMethod("push", &CStream::Push),
                        InstanceMethod("pushAsync", &CStream::PushAsyncMode),
                        InstanceMethod("close", &CStream::Close)});
  }

  // new CStream(level, blockSize, flags, dict | null)
  explicit CStream(const Napi::CallbackInfo& info) : StreamBase<CStream>(info) {
    int level = IntArg(info, 0, "level");
    int block_size = IntArg(info, 1, "blockSize");
    int flags = IntArg(info, 2, "flags");
    std::vector<uint8_t> dict = OptionalBytesCopy(info, 3, "dictionary");
    const char* detail = nullptr;
    int rc = ljs_cstream_create(level, block_size, flags, DataOrNull(dict), dict.size(), &stream_,
                                &detail);
    if (rc != LJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~CStream() override { ljs_cstream_free(stream_); }

  static int Job(ljs_cstream* ctx, const uint8_t* src, size_t size, int mode, ljs_buf* out,
                 const char** detail) {
    return ljs_cstream_push(ctx, src, size, mode, out, detail);
  }
  ljs_cstream* Context() { return stream_; }
  void FreeContext() {
    ljs_cstream_free(stream_);
    stream_ = nullptr;
  }

 private:
  // push(chunk, mode) / pushAsync(chunk, mode)
  Napi::Value Push(const Napi::CallbackInfo& info) { return PushSync(info, IntArg(info, 1, "mode")); }
  Napi::Value PushAsyncMode(const Napi::CallbackInfo& info) { return PushAsync(info, IntArg(info, 1, "mode")); }

  ljs_cstream* stream_ = nullptr;
};

class DStream : public StreamBase<DStream> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "DStream",
                       {InstanceMethod("push", &DStream::Push),
                        InstanceMethod("pushAsync", &DStream::PushAsyncChunk),
                        InstanceMethod("finish", &DStream::Finish),
                        InstanceMethod("close", &DStream::Close)});
  }

  // new DStream(dict | null, maxOutput)
  explicit DStream(const Napi::CallbackInfo& info) : StreamBase<DStream>(info) {
    std::vector<uint8_t> dict = OptionalBytesCopy(info, 0, "dictionary");
    size_t max_output = LimitArg(info, 1, "maxOutputSize");
    const char* detail = nullptr;
    int rc = ljs_dstream_create(DataOrNull(dict), dict.size(), max_output, &stream_, &detail);
    if (rc != LJS_OK) throw MakeError(info.Env(), rc, detail);
  }
  ~DStream() override { ljs_dstream_free(stream_); }

  static int Job(ljs_dstream* ctx, const uint8_t* src, size_t size, int /*mode*/, ljs_buf* out,
                 const char** detail) {
    return ljs_dstream_push(ctx, src, size, out, detail);
  }
  ljs_dstream* Context() { return stream_; }
  void FreeContext() {
    ljs_dstream_free(stream_);
    stream_ = nullptr;
  }

 private:
  // push(chunk) / pushAsync(chunk)
  Napi::Value Push(const Napi::CallbackInfo& info) { return PushSync(info, 0); }
  Napi::Value PushAsyncChunk(const Napi::CallbackInfo& info) { return PushAsync(info, 0); }

  // finish(): throws if the input ended inside a frame
  Napi::Value Finish(const Napi::CallbackInfo& info) {
    Acquire(info.Env());
    const char* detail = nullptr;
    int rc = ljs_dstream_finish(stream_, &detail);
    Release();
    if (rc != LJS_OK) throw MakeError(info.Env(), rc, detail);
    return info.Env().Undefined();
  }

  ljs_dstream* stream_ = nullptr;
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("compressSync", Napi::Function::New(env, CompressSync));
  exports.Set("compress", Napi::Function::New(env, Compress));
  exports.Set("decompressSync", Napi::Function::New(env, DecompressSync));
  exports.Set("decompress", Napi::Function::New(env, Decompress));
  exports.Set("compressBlockSync", Napi::Function::New(env, CompressBlockSync));
  exports.Set("compressBlock", Napi::Function::New(env, CompressBlock));
  exports.Set("decompressBlockSync", Napi::Function::New(env, DecompressBlockSync));
  exports.Set("decompressBlock", Napi::Function::New(env, DecompressBlock));
  exports.Set("frameContentSize", Napi::Function::New(env, FrameContentSize));
  exports.Set("version", Napi::String::New(env, ljs_version()));
  exports.Set("minLevel", Napi::Number::New(env, ljs_min_level()));
  exports.Set("maxLevel", Napi::Number::New(env, ljs_max_level()));
  exports.Set("defaultLevel", Napi::Number::New(env, ljs_default_level()));
  exports.Set("CStream", CStream::Init(env));
  exports.Set("DStream", DStream::Init(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(lz4_js, Init)
