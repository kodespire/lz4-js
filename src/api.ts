import {
  resolveBlockCompressOptions,
  resolveBlockDecompressOptions,
  resolveCompressOptions,
  resolveDecompressOptions,
  toBytes,
  toInputBytes,
} from './options.js';
import {
  MODE_CONTINUE,
  MODE_END,
  type Backend,
  type BackendKind,
  type BackendProvider,
  type BlockCompressOptions,
  type BlockDecompressOptions,
  type Bytes,
  type CompressOptions,
  type CompressStreamOptions,
  type CStreamHandle,
  type DecompressOptions,
  type DStreamHandle,
  type WasmSource,
} from './types.js';

const EMPTY = new Uint8Array(0);

/**
 * True if `data` starts with an LZ4 frame or a skippable frame. Does not validate the rest.
 * The legacy format (`lz4 -l`) and raw blocks have no frame magic number and give false.
 */
export function isLz4Frame(data: Bytes): boolean {
  const b = toBytes(data, 'data');
  if (b.length < 4) return false;
  const magic = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  return magic === 0x184d2204 || (magic & 0xfffffff0) === 0x184d2a50;
}

export function createApi(provider: BackendProvider) {
  /**
   * Starts an async call. Like the sync functions, it reads the caller's bytes before
   * returning, so they can be reused right away: a loaded backend copies them at once,
   * and while the backend is still loading they are copied here.
   */
  function withBackend<T>(inputs: (Uint8Array | null)[], call: (backend: Backend, inputs: (Uint8Array | null)[]) => T | Promise<T>): Promise<T> {
    const backend = provider.ready();
    if (backend) return Promise.resolve(call(backend, inputs));
    const copies = inputs.map((input) => input && input.slice());
    return provider.get().then((b) => call(b, copies));
  }

  /** Compresses `data` into a single LZ4 frame. Strings are encoded as UTF-8. */
  async function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array> {
    const o = resolveCompressOptions(options, 'compress');
    return withBackend([toInputBytes(data), o.dictionary], (b, [input, dict]) =>
      b.compress(input!, o.level, o.blockSize, o.flags, dict!));
  }

  /** Synchronous `compress`. In browsers and edge runtimes, call `await init()` first. */
  function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array {
    const o = resolveCompressOptions(options, 'compressSync');
    return provider.getSync().compressSync(toInputBytes(data), o.level, o.blockSize, o.flags, o.dictionary);
  }

  /**
   * Decompresses every frame in `data`. Throws Lz4Error if the data is corrupt, ends
   * mid-frame (ERR_LZ4_TRUNCATED) or would exceed `maxOutputSize` (ERR_LZ4_OUTPUT_LIMIT).
   */
  async function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array> {
    const o = resolveDecompressOptions(options, 'decompress');
    return withBackend([toBytes(data, 'data'), o.dictionary], (b, [input, dict]) =>
      b.decompress(input!, dict!, o.maxOutputSize));
  }

  /** Synchronous `decompress`. In browsers and edge runtimes, call `await init()` first. */
  function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array {
    const o = resolveDecompressOptions(options, 'decompressSync');
    return provider.getSync().decompressSync(toBytes(data, 'data'), o.dictionary, o.maxOutputSize);
  }

  /** Compresses `data` into one raw LZ4 block (no frame: no header, checksum or size). */
  async function compressBlock(data: Bytes | string, options?: BlockCompressOptions | number): Promise<Uint8Array> {
    const o = resolveBlockCompressOptions(options, 'compressBlock');
    return withBackend([toInputBytes(data), o.dictionary], (b, [input, dict]) => b.compressBlock(input!, o.level, dict!));
  }

  /** Synchronous `compressBlock`. In browsers and edge runtimes, call `await init()` first. */
  function compressBlockSync(data: Bytes | string, options?: BlockCompressOptions | number): Uint8Array {
    const o = resolveBlockCompressOptions(options, 'compressBlockSync');
    return provider.getSync().compressBlockSync(toInputBytes(data), o.level, o.dictionary);
  }

  /** Decompresses one raw LZ4 block. A number in place of the options is the exact original size. */
  async function decompressBlock(data: Bytes, options: BlockDecompressOptions | number): Promise<Uint8Array> {
    const o = resolveBlockDecompressOptions(options, 'decompressBlock');
    return withBackend([toBytes(data, 'data'), o.dictionary], (b, [input, dict]) =>
      b.decompressBlock(input!, dict!, o.size, o.exact));
  }

  /** Synchronous `decompressBlock`. In browsers and edge runtimes, call `await init()` first. */
  function decompressBlockSync(data: Bytes, options: BlockDecompressOptions | number): Uint8Array {
    const o = resolveBlockDecompressOptions(options, 'decompressBlockSync');
    return provider.getSync().decompressBlockSync(toBytes(data, 'data'), o.dictionary, o.size, o.exact);
  }

  /**
   * The decompressed size recorded in the first frame's header, or null if the frame does not
   * record it (typical for streamed output). Headers are untrusted: still pass `maxOutputSize`.
   */
  function getFrameContentSize(data: Bytes): number | null {
    const size = provider.getSync().frameContentSize(toBytes(data, 'data'));
    return size < 0 ? null : size;
  }

  /** A TransformStream that compresses its input into one LZ4 frame. */
  function createCompressStream(options?: CompressStreamOptions | number): TransformStream<Bytes, Uint8Array> {
    const o = resolveCompressOptions(options, 'createCompressStream', true);
    let handle: CStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      async start() {
        handle = await withBackend([o.dictionary], (b, [dict]) => b.createCStream(o.level, o.blockSize, o.flags, dict!));
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'), MODE_CONTINUE);
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      async flush(controller) {
        try {
          const out = await handle!.pushAsync(EMPTY, MODE_END);
          if (out.length > 0) controller.enqueue(out);
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * A TransformStream that decompresses LZ4 frames. Errors if the input is corrupt, ends
   * mid-frame or exceeds `maxOutputSize` in total.
   */
  function createDecompressStream(options?: DecompressOptions): TransformStream<Bytes, Uint8Array> {
    const o = resolveDecompressOptions(options, 'createDecompressStream');
    let handle: DStreamHandle | undefined;
    const close = () => {
      handle?.close();
      handle = undefined;
    };
    return new TransformStream<Bytes, Uint8Array>({
      async start() {
        handle = await withBackend([o.dictionary], (b, [dict]) => b.createDStream(dict!, o.maxOutputSize));
      },
      async transform(chunk, controller) {
        try {
          const out = await handle!.pushAsync(toBytes(chunk, 'chunk'));
          if (out.length > 0) controller.enqueue(out);
        } catch (error) {
          close();
          throw error;
        }
      },
      flush() {
        try {
          handle!.finish();
        } finally {
          close();
        }
      },
      cancel: close,
    } as Transformer<Bytes, Uint8Array>);
  }

  /**
   * Loads the backend ahead of time. Required before synchronous calls in browsers and edge
   * runtimes. `source` overrides where the WebAssembly module is loaded from; it is ignored
   * when the native addon is in use.
   */
  async function init(source?: WasmSource): Promise<void> {
    await provider.init(source);
  }

  /** Which implementation is running: the native addon or WebAssembly. */
  function activeBackend(): BackendKind {
    return provider.kind();
  }

  return {
    compress,
    compressSync,
    decompress,
    decompressSync,
    compressBlock,
    compressBlockSync,
    decompressBlock,
    decompressBlockSync,
    getFrameContentSize,
    createCompressStream,
    createDecompressStream,
    init,
    activeBackend,
  };
}
