// JSI binding. Moves bytes between JavaScript and the ljs C layer; all
// compression logic lives in csrc/ljs.c. Mirrors csrc/addon.cc: the same
// methods, arguments and errors (Error objects carrying a numeric `ljsCode`,
// which the TypeScript layer turns into Lz4Error).
//
// Threading: synchronous methods run on the JS thread. Async methods copy their
// inputs on the JS thread, run on a small worker pool, and settle their promise
// back on the JS thread through the CallInvoker. Workers never touch JSI values:
// they carry a promise id and plain bytes, so a job that finishes after a reload
// or teardown finds nothing to settle. The pending resolve/reject functions live
// in the module, which React Native destroys before its runtime.

#include "KodespireLz4Module.h"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <pthread.h>

#include "ljs.h"

namespace facebook::react {
namespace kodespire_lz4 {

// ---- worker pool -----------------------------------------------------------

// A fixed set of threads shared by every runtime. Never destroyed: a job may
// still be running when the process exits.
class WorkerPool {
 public:
  static WorkerPool& shared() {
    static WorkerPool* pool = new WorkerPool();
    return *pool;
  }

  void submit(std::function<void()> job) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      queue_.push_back(std::move(job));
    }
    ready_.notify_one();
  }

 private:
  WorkerPool() {
    unsigned cores = std::thread::hardware_concurrency();
    unsigned count = std::clamp(cores > 1 ? cores - 1 : 1u, 1u, 4u);
    for (unsigned i = 0; i < count; i++) std::thread([this] { Run(); }).detach();
  }

  void Run() {
#if defined(__APPLE__)
    pthread_setname_np("lz4-js");
#else
    pthread_setname_np(pthread_self(), "lz4-js");
#endif
    for (;;) {
      std::function<void()> job;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock, [this] { return !queue_.empty(); });
        job = std::move(queue_.front());
        queue_.pop_front();
      }
      job();
    }
  }

  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::function<void()>> queue_;
};

// ---- bytes and errors --------------------------------------------------------

// Hands an ljs_buf to JavaScript as an ArrayBuffer without copying. Leaves `buf` empty.
class OwnedBuffer : public jsi::MutableBuffer {
 public:
  explicit OwnedBuffer(ljs_buf* buf) : buf_(*buf) {
    *buf = ljs_buf{};
    if (buf_.cap - buf_.size > 4096) {
      void* shrunk = realloc(buf_.data, buf_.size > 0 ? buf_.size : 1);
      if (shrunk) {
        buf_.data = static_cast<uint8_t*>(shrunk);
        buf_.cap = buf_.size;
      }
    }
  }
  ~OwnedBuffer() override { ljs_buf_free(&buf_); }
  size_t size() const override { return buf_.size; }
  uint8_t* data() override { return buf_.data ? buf_.data : &empty_; }

 private:
  ljs_buf buf_;
  uint8_t empty_ = 0;
};

jsi::Value TakeBuffer(jsi::Runtime& rt, ljs_buf* buf) {
  return jsi::ArrayBuffer(rt, std::make_shared<OwnedBuffer>(buf));
}

jsi::Value MakeError(jsi::Runtime& rt, int code, const char* detail) {
  jsi::Object error = rt.global()
                          .getPropertyAsFunction(rt, "Error")
                          .callAsConstructor(rt, jsi::String::createFromUtf8(rt, detail ? detail : "lz4 error"))
                          .asObject(rt);
  error.setProperty(rt, "ljsCode", code);
  return jsi::Value(std::move(error));
}

[[noreturn]] void ThrowError(jsi::Runtime& rt, int code, const char* detail) {
  throw jsi::JSError(rt, MakeError(rt, code, detail));
}

[[noreturn]] void ThrowJsError(jsi::Runtime& rt, const char* type, const std::string& message) {
  jsi::Value error =
      rt.global().getPropertyAsFunction(rt, type).callAsConstructor(rt, jsi::String::createFromUtf8(rt, message));
  throw jsi::JSError(rt, std::move(error));
}

[[noreturn]] void ThrowTypeError(jsi::Runtime& rt, const std::string& message) {
  ThrowJsError(rt, "TypeError", message);
}

struct Bytes {
  const uint8_t* data = nullptr;
  size_t size = 0;
};

// A Uint8Array argument, read through its buffer, byteOffset and byteLength
// (JSI has no typed-array API before React Native 0.85).
Bytes BytesArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  const std::string message = std::string(name) + " must be a Uint8Array";
  if (index >= count || !args[index].isObject()) ThrowTypeError(rt, message);
  jsi::Object view = args[index].getObject(rt);
  if (!view.instanceOf(rt, rt.global().getPropertyAsFunction(rt, "Uint8Array"))) ThrowTypeError(rt, message);
  jsi::Value buffer = view.getProperty(rt, "buffer");
  jsi::Value offset = view.getProperty(rt, "byteOffset");
  jsi::Value length = view.getProperty(rt, "byteLength");
  if (!buffer.isObject() || !buffer.getObject(rt).isArrayBuffer(rt) || !offset.isNumber() || !length.isNumber()) {
    ThrowTypeError(rt, message);
  }
  jsi::ArrayBuffer array = buffer.getObject(rt).getArrayBuffer(rt);
  double start = offset.getNumber();
  double size = length.getNumber();
  if (start < 0 || size < 0 || start + size > static_cast<double>(array.size(rt))) ThrowTypeError(rt, message);
  return {array.data(rt) + static_cast<size_t>(start), static_cast<size_t>(size)};
}

// Optional Uint8Array: null/undefined -> empty.
Bytes OptionalBytesArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  if (index >= count || args[index].isNull() || args[index].isUndefined()) return {};
  return BytesArg(rt, args, count, index, name);
}

std::vector<uint8_t> Copy(Bytes bytes) {
  return std::vector<uint8_t>(bytes.data, bytes.data + bytes.size);
}

const uint8_t* DataOrNull(const std::vector<uint8_t>& v) {
  return v.empty() ? nullptr : v.data();
}

// Bytes a job reads: the caller's memory for sync calls, or a copy it owns for
// async ones (JavaScript may change or detach the source while the job runs).
struct Input {
  std::shared_ptr<const std::vector<uint8_t>> copy;
  const uint8_t* data = nullptr;
  size_t size = 0;
};

Input MakeInput(Bytes bytes, bool copy) {
  if (!copy) return {nullptr, bytes.data, bytes.size};
  auto owned = std::make_shared<const std::vector<uint8_t>>(Copy(bytes));
  return {owned, DataOrNull(*owned), owned->size()};
}

int32_t IntArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  if (index >= count || !args[index].isNumber()) ThrowTypeError(rt, std::string(name) + " must be a number");
  double d = args[index].getNumber();
  return std::isfinite(d) ? static_cast<int32_t>(std::clamp(d, -2147483648.0, 2147483647.0)) : 0;
}

bool BoolArg(const jsi::Value* args, size_t count, size_t index) {
  return index < count && args[index].isBool() && args[index].getBool();
}

// Number -> size_t limit. Infinity (and anything >= SIZE_MAX) means no limit.
size_t LimitArg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t index, const char* name) {
  if (index >= count || !args[index].isNumber()) ThrowTypeError(rt, std::string(name) + " must be a number");
  double d = args[index].getNumber();
  if (std::isnan(d) || d < 0) ThrowJsError(rt, "RangeError", std::string(name) + " must be a non-negative number");
  if (std::isinf(d) || d >= static_cast<double>(SIZE_MAX)) return SIZE_MAX;
  return static_cast<size_t>(d);
}

jsi::Function MakeFunction(jsi::Runtime& rt, const char* name, unsigned int length, jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, name), length, std::move(fn));
}

// ---- jobs --------------------------------------------------------------------

struct Result {
  int rc = LJS_OK;
  const char* detail = nullptr;
  ljs_buf out{};
  ~Result() { ljs_buf_free(&out); }
};

using Job = std::function<int(ljs_buf* out, const char** detail)>;

// Runs `job` now, on the JS thread, and returns its output or throws.
jsi::Value RunSync(jsi::Runtime& rt, const Job& job) {
  ljs_buf out{};
  const char* detail = nullptr;
  int rc = job(&out, &detail);
  if (rc != LJS_OK) {
    ljs_buf_free(&out);
    ThrowError(rt, rc, detail);
  }
  return TakeBuffer(rt, &out);
}

class Promises {
 public:
  // Creates a promise whose resolve/reject stay here, on the JS thread, until settle().
  jsi::Value Create(jsi::Runtime& rt, uint64_t* id) {
    uint64_t key = next_++;
    jsi::Function executor =
        MakeFunction(rt, "executor", 2, [this, key](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t) {
          pending_.emplace(key, Pending{args[0].getObject(rt).getFunction(rt), args[1].getObject(rt).getFunction(rt)});
          return jsi::Value::undefined();
        });
    jsi::Value promise = rt.global().getPropertyAsFunction(rt, "Promise").callAsConstructor(rt, executor);
    *id = key;
    return promise;
  }

  void Settle(jsi::Runtime& rt, uint64_t id, Result& result) {
    auto it = pending_.find(id);
    if (it == pending_.end()) return;
    Pending pending = std::move(it->second);
    pending_.erase(it);
    if (result.rc == LJS_OK) {
      pending.resolve.call(rt, TakeBuffer(rt, &result.out));
    } else {
      pending.reject.call(rt, MakeError(rt, result.rc, result.detail));
    }
  }

 private:
  struct Pending {
    jsi::Function resolve;
    jsi::Function reject;
  };
  std::unordered_map<uint64_t, Pending> pending_;
  uint64_t next_ = 1;
};

// Runs `job` on the worker pool and returns a promise for its output. `done`
// runs on the JS thread before the promise settles (streams use it to release
// their context); it is dropped unrun if the runtime has gone away.
jsi::Value RunAsync(jsi::Runtime& rt, const std::shared_ptr<Promises>& promises,
                    const std::weak_ptr<CallInvoker>& invoker, Job job, std::function<void()> done = nullptr) {
  uint64_t id = 0;
  jsi::Value promise = promises->Create(rt, &id);
  std::weak_ptr<Promises> weakPromises = promises;
  WorkerPool::shared().submit([job = std::move(job), done = std::move(done), weakPromises, invoker, id]() {
    auto result = std::make_shared<Result>();
    result->rc = job(&result->out, &result->detail);
    std::shared_ptr<CallInvoker> jsInvoker = invoker.lock();
    if (!jsInvoker) return;
    jsInvoker->invokeAsync([weakPromises, id, result, done](jsi::Runtime& rt) {
      if (done) done();
      if (std::shared_ptr<Promises> live = weakPromises.lock()) live->Settle(rt, id, *result);
    });
  });
  return promise;
}

// The one-shot calls, as in csrc/addon.cc. `copy` is true for the async versions.

// compressSync / compress(data, level, blockSize, flags, dict | null)
Job CompressJob(jsi::Runtime& rt, const jsi::Value* args, size_t count, bool copy) {
  Input src = MakeInput(BytesArg(rt, args, count, 0, "data"), copy);
  int level = IntArg(rt, args, count, 1, "level");
  int blockSize = IntArg(rt, args, count, 2, "blockSize");
  int flags = IntArg(rt, args, count, 3, "flags");
  Input dict = MakeInput(OptionalBytesArg(rt, args, count, 4, "dictionary"), copy);
  return [src, dict, level, blockSize, flags](ljs_buf* out, const char** detail) {
    return ljs_compress(src.data, src.size, level, blockSize, flags, dict.data, dict.size, out, detail);
  };
}

// decompressSync / decompress(data, dict | null, maxOutput)
Job DecompressJob(jsi::Runtime& rt, const jsi::Value* args, size_t count, bool copy) {
  Input src = MakeInput(BytesArg(rt, args, count, 0, "data"), copy);
  Input dict = MakeInput(OptionalBytesArg(rt, args, count, 1, "dictionary"), copy);
  size_t maxOutput = LimitArg(rt, args, count, 2, "maxOutputSize");
  return [src, dict, maxOutput](ljs_buf* out, const char** detail) {
    return ljs_decompress(src.data, src.size, dict.data, dict.size, maxOutput, out, detail);
  };
}

// compressBlockSync / compressBlock(data, level, dict | null)
Job CompressBlockJob(jsi::Runtime& rt, const jsi::Value* args, size_t count, bool copy) {
  Input src = MakeInput(BytesArg(rt, args, count, 0, "data"), copy);
  int level = IntArg(rt, args, count, 1, "level");
  Input dict = MakeInput(OptionalBytesArg(rt, args, count, 2, "dictionary"), copy);
  return [src, dict, level](ljs_buf* out, const char** detail) {
    return ljs_compress_block(src.data, src.size, level, dict.data, dict.size, out, detail);
  };
}

// decompressBlockSync / decompressBlock(data, dict | null, size, exact)
Job DecompressBlockJob(jsi::Runtime& rt, const jsi::Value* args, size_t count, bool copy) {
  Input src = MakeInput(BytesArg(rt, args, count, 0, "data"), copy);
  Input dict = MakeInput(OptionalBytesArg(rt, args, count, 1, "dictionary"), copy);
  size_t size = LimitArg(rt, args, count, 2, "size");
  int exact = BoolArg(args, count, 3) ? 1 : 0;
  return [src, dict, size, exact](ljs_buf* out, const char** detail) {
    return ljs_decompress_block(src.data, src.size, dict.data, dict.size, size, exact, out, detail);
  };
}

// ---- streams -----------------------------------------------------------------

// One operation at a time per stream. The context is freed by close() (or,
// when a push is in flight, as soon as it finishes) or with the last reference:
// the JS object and any in-flight job each hold one. `busy` and `closed` are
// only read and written on the JS thread.
template <typename Context, void (*Free)(Context*)>
struct StreamState {
  Context* context = nullptr;
  bool busy = false;
  bool closed = false;

  ~StreamState() { Free(context); }

  void Acquire(jsi::Runtime& rt) {
    if (closed) ThrowError(rt, LJS_ERR_ARG, "stream is closed");
    if (busy) ThrowError(rt, LJS_ERR_ARG, "stream is busy: wait for the previous push to finish");
    busy = true;
  }
  void Release() {
    busy = false;
    if (closed) FreeContext();
  }
  void Close() {
    closed = true;
    if (!busy) FreeContext();
  }
  void FreeContext() {
    Free(context);
    context = nullptr;
  }
};

using CState = StreamState<ljs_cstream, ljs_cstream_free>;
using DState = StreamState<ljs_dstream, ljs_dstream_free>;

// Exposes a stream's methods as plain functions, so they work detached from the object.
class StreamObject : public jsi::HostObject {
 public:
  using Methods = std::unordered_map<std::string, std::function<jsi::Function(jsi::Runtime&)>>;
  explicit StreamObject(Methods methods) : methods_(std::move(methods)) {}

  jsi::Value get(jsi::Runtime& rt, const jsi::PropNameID& name) override {
    auto it = methods_.find(name.utf8(rt));
    if (it == methods_.end()) return jsi::Value::undefined();
    return it->second(rt);
  }

  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override {
    std::vector<jsi::PropNameID> names;
    for (const auto& entry : methods_) names.push_back(jsi::PropNameID::forUtf8(rt, entry.first));
    return names;
  }

 private:
  Methods methods_;
};

jsi::Value MakeCStream(jsi::Runtime& rt, KodespireLz4Module& module, const jsi::Value* args, size_t count) {
  int level = IntArg(rt, args, count, 0, "level");
  int blockSize = IntArg(rt, args, count, 1, "blockSize");
  int flags = IntArg(rt, args, count, 2, "flags");
  Bytes dict = OptionalBytesArg(rt, args, count, 3, "dictionary");
  auto state = std::make_shared<CState>();
  const char* detail = nullptr;
  int rc = ljs_cstream_create(level, blockSize, flags, dict.data, dict.size, &state->context, &detail);
  if (rc != LJS_OK) ThrowError(rt, rc, detail);

  std::shared_ptr<Promises> promises = module.promises();
  std::weak_ptr<CallInvoker> invoker = module.invoker();
  StreamObject::Methods methods;
  // push(chunk, mode): ArrayBuffer
  methods["push"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "push", 2, [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
      Bytes chunk = BytesArg(rt, args, count, 0, "chunk");
      int mode = IntArg(rt, args, count, 1, "mode");
      state->Acquire(rt);
      ljs_buf out{};
      const char* detail = nullptr;
      int rc = ljs_cstream_push(state->context, chunk.data, chunk.size, mode, &out, &detail);
      state->Release();
      if (rc != LJS_OK) {
        ljs_buf_free(&out);
        ThrowError(rt, rc, detail);
      }
      return TakeBuffer(rt, &out);
    });
  };
  // pushAsync(chunk, mode): Promise<ArrayBuffer>
  methods["pushAsync"] = [state, promises, invoker](jsi::Runtime& rt) {
    return MakeFunction(rt, "pushAsync", 2,
                        [state, promises, invoker](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
                          std::vector<uint8_t> chunk = Copy(BytesArg(rt, args, count, 0, "chunk"));
                          int mode = IntArg(rt, args, count, 1, "mode");
                          state->Acquire(rt);
                          try {
                            return RunAsync(
                                rt, promises, invoker,
                                [state, chunk = std::move(chunk), mode](ljs_buf* out, const char** detail) {
                                  return ljs_cstream_push(state->context, DataOrNull(chunk), chunk.size(), mode, out, detail);
                                },
                                [state] { state->Release(); });
                          } catch (...) {
                            state->Release();
                            throw;
                          }
                        });
  };
  // close(): frees the context now, or once an in-flight push finishes
  methods["close"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "close", 0, [state](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
      state->Close();
      return jsi::Value::undefined();
    });
  };
  return jsi::Object::createFromHostObject(rt, std::make_shared<StreamObject>(std::move(methods)));
}

jsi::Value MakeDStream(jsi::Runtime& rt, KodespireLz4Module& module, const jsi::Value* args, size_t count) {
  Bytes dict = OptionalBytesArg(rt, args, count, 0, "dictionary");
  size_t maxOutput = LimitArg(rt, args, count, 1, "maxOutputSize");
  auto state = std::make_shared<DState>();
  const char* detail = nullptr;
  int rc = ljs_dstream_create(dict.data, dict.size, maxOutput, &state->context, &detail);
  if (rc != LJS_OK) ThrowError(rt, rc, detail);

  std::shared_ptr<Promises> promises = module.promises();
  std::weak_ptr<CallInvoker> invoker = module.invoker();
  StreamObject::Methods methods;
  // push(chunk): ArrayBuffer
  methods["push"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "push", 1, [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
      Bytes chunk = BytesArg(rt, args, count, 0, "chunk");
      state->Acquire(rt);
      ljs_buf out{};
      const char* detail = nullptr;
      int rc = ljs_dstream_push(state->context, chunk.data, chunk.size, &out, &detail);
      state->Release();
      if (rc != LJS_OK) {
        ljs_buf_free(&out);
        ThrowError(rt, rc, detail);
      }
      return TakeBuffer(rt, &out);
    });
  };
  // pushAsync(chunk): Promise<ArrayBuffer>
  methods["pushAsync"] = [state, promises, invoker](jsi::Runtime& rt) {
    return MakeFunction(rt, "pushAsync", 1,
                        [state, promises, invoker](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) {
                          std::vector<uint8_t> chunk = Copy(BytesArg(rt, args, count, 0, "chunk"));
                          state->Acquire(rt);
                          try {
                            return RunAsync(
                                rt, promises, invoker,
                                [state, chunk = std::move(chunk)](ljs_buf* out, const char** detail) {
                                  return ljs_dstream_push(state->context, DataOrNull(chunk), chunk.size(), out, detail);
                                },
                                [state] { state->Release(); });
                          } catch (...) {
                            state->Release();
                            throw;
                          }
                        });
  };
  // finish(): throws if the input ended inside a frame
  methods["finish"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "finish", 0, [state](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
      state->Acquire(rt);
      const char* detail = nullptr;
      int rc = ljs_dstream_finish(state->context, &detail);
      state->Release();
      if (rc != LJS_OK) ThrowError(rt, rc, detail);
      return jsi::Value::undefined();
    });
  };
  methods["close"] = [state](jsi::Runtime& rt) {
    return MakeFunction(rt, "close", 0, [state](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) {
      state->Close();
      return jsi::Value::undefined();
    });
  };
  return jsi::Object::createFromHostObject(rt, std::make_shared<StreamObject>(std::move(methods)));
}

// ---- module methods ------------------------------------------------------------

KodespireLz4Module& Self(TurboModule& module) {
  return static_cast<KodespireLz4Module&>(module);
}

jsi::Value Async(jsi::Runtime& rt, TurboModule& module, Job job) {
  return RunAsync(rt, Self(module).promises(), Self(module).invoker(), std::move(job));
}

// version(): string
jsi::Value Version(jsi::Runtime& rt, TurboModule&, const jsi::Value*, size_t) {
  return jsi::String::createFromUtf8(rt, ljs_version());
}

// compressSync(data, level, blockSize, flags, dict | null): ArrayBuffer
jsi::Value CompressSync(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  return RunSync(rt, CompressJob(rt, args, count, false));
}

// compress(data, level, blockSize, flags, dict | null): Promise<ArrayBuffer>
jsi::Value Compress(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return Async(rt, module, CompressJob(rt, args, count, true));
}

// decompressSync(data, dict | null, maxOutput): ArrayBuffer
jsi::Value DecompressSync(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  return RunSync(rt, DecompressJob(rt, args, count, false));
}

// decompress(data, dict | null, maxOutput): Promise<ArrayBuffer>
jsi::Value Decompress(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return Async(rt, module, DecompressJob(rt, args, count, true));
}

// compressBlockSync(data, level, dict | null): ArrayBuffer
jsi::Value CompressBlockSync(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  return RunSync(rt, CompressBlockJob(rt, args, count, false));
}

// compressBlock(data, level, dict | null): Promise<ArrayBuffer>
jsi::Value CompressBlock(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return Async(rt, module, CompressBlockJob(rt, args, count, true));
}

// decompressBlockSync(data, dict | null, size, exact): ArrayBuffer
jsi::Value DecompressBlockSync(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  return RunSync(rt, DecompressBlockJob(rt, args, count, false));
}

// decompressBlock(data, dict | null, size, exact): Promise<ArrayBuffer>
jsi::Value DecompressBlock(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return Async(rt, module, DecompressBlockJob(rt, args, count, true));
}

// frameContentSize(data): number (-1 when the header does not record it)
jsi::Value FrameContentSize(jsi::Runtime& rt, TurboModule&, const jsi::Value* args, size_t count) {
  Bytes src = BytesArg(rt, args, count, 0, "data");
  double size = 0;
  const char* detail = nullptr;
  int rc = ljs_frame_content_size(src.data, src.size, &size, &detail);
  if (rc != LJS_OK) ThrowError(rt, rc, detail);
  return size;
}

// createCStream(level, blockSize, flags, dict | null): { push, pushAsync, close }
jsi::Value CreateCStream(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return MakeCStream(rt, Self(module), args, count);
}

// createDStream(dict | null, maxOutput): { push, pushAsync, finish, close }
jsi::Value CreateDStream(jsi::Runtime& rt, TurboModule& module, const jsi::Value* args, size_t count) {
  return MakeDStream(rt, Self(module), args, count);
}

}  // namespace kodespire_lz4

KodespireLz4Module::KodespireLz4Module(std::shared_ptr<CallInvoker> jsInvoker)
    : TurboModule(kModuleName, std::move(jsInvoker)), promises_(std::make_shared<kodespire_lz4::Promises>()) {
  using namespace kodespire_lz4;
  methodMap_["version"] = MethodMetadata{0, Version};
  methodMap_["compressSync"] = MethodMetadata{5, CompressSync};
  methodMap_["compress"] = MethodMetadata{5, Compress};
  methodMap_["decompressSync"] = MethodMetadata{3, DecompressSync};
  methodMap_["decompress"] = MethodMetadata{3, Decompress};
  methodMap_["compressBlockSync"] = MethodMetadata{3, CompressBlockSync};
  methodMap_["compressBlock"] = MethodMetadata{3, CompressBlock};
  methodMap_["decompressBlockSync"] = MethodMetadata{4, DecompressBlockSync};
  methodMap_["decompressBlock"] = MethodMetadata{4, DecompressBlock};
  methodMap_["frameContentSize"] = MethodMetadata{1, FrameContentSize};
  methodMap_["createCStream"] = MethodMetadata{4, CreateCStream};
  methodMap_["createDStream"] = MethodMetadata{2, CreateDStream};
}

KodespireLz4Module::~KodespireLz4Module() = default;

}  // namespace facebook::react
