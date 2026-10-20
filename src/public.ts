// The documented public API. This file only declares; each entry point
// (entry-node.ts, entry-wasm.ts, entry-workerd.js) implements it, and
// test/types.test-d.ts checks that they match. package.json points "types" here.
import type {
  BackendKind,
  BlockCompressOptions,
  BlockDecompressOptions,
  Bytes,
  CompressOptions,
  CompressStreamOptions,
  DecompressOptions,
  WasmSource,
} from './types.js';

/**
 * Compresses `data` into a single LZ4 frame, the format the `lz4` command-line tool reads and writes.
 *
 * @param data Bytes to compress. Strings are encoded as UTF-8.
 * @param options Options, or just a compression level (`compress(data, 9)`).
 * @example
 * const packed = await compress(data, { level: 9 });
 */
export declare function compress(data: Bytes | string, options?: CompressOptions | number): Promise<Uint8Array>;

/**
 * Synchronous {@link compress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function compressSync(data: Bytes | string, options?: CompressOptions | number): Uint8Array;

/**
 * Decompresses every LZ4 frame in `data` (concatenated frames are joined, skippable frames skipped).
 *
 * Throws an {@link Lz4Error} with code `ERR_LZ4_TRUNCATED` if the input is empty or ends
 * partway through a frame, `ERR_LZ4_OUTPUT_LIMIT` if the output would exceed `maxOutputSize`,
 * and `ERR_LZ4_LIBRARY` if the data is corrupt or not an LZ4 frame. It never returns partial output.
 *
 * @example
 * const data = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
 */
export declare function decompress(data: Bytes, options?: DecompressOptions): Promise<Uint8Array>;

/**
 * Synchronous {@link decompress}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function decompressSync(data: Bytes, options?: DecompressOptions): Uint8Array;

/**
 * Compresses `data` into one raw LZ4 block: just the compressed sequences, with no header,
 * size, checksum or end marker. For formats that store blocks themselves; otherwise use
 * {@link compress}. Input is limited to 2113929216 bytes.
 *
 * @param data Bytes to compress. Strings are encoded as UTF-8.
 * @param options Options, or just a compression level.
 * @example
 * const block = await compressBlock(data);
 * store(data.length, block); // the size is needed to decompress
 */
export declare function compressBlock(data: Bytes | string, options?: BlockCompressOptions | number): Promise<Uint8Array>;

/**
 * Synchronous {@link compressBlock}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function compressBlockSync(data: Bytes | string, options?: BlockCompressOptions | number): Uint8Array;

/**
 * Decompresses one raw LZ4 block. A block does not record its size, so pass either the exact
 * `originalSize` (or just that number) or a `maxOutputSize` bound.
 *
 * With `originalSize`, a block that decodes to fewer bytes throws `ERR_LZ4_TRUNCATED` and one
 * that decodes to more throws `ERR_LZ4_OUTPUT_LIMIT`, so cut-off blocks are always caught.
 * With `maxOutputSize`, a block cut off right after a run of literals decodes to a shorter
 * result: the block format cannot tell. Corrupt data throws `ERR_LZ4_LIBRARY`.
 *
 * @example
 * const data = await decompressBlock(block, storedLength);
 */
export declare function decompressBlock(data: Bytes, options: BlockDecompressOptions | number): Promise<Uint8Array>;

/**
 * Synchronous {@link decompressBlock}. In browsers, Deno and Workers, `await init()` must have run first.
 */
export declare function decompressBlockSync(data: Bytes, options: BlockDecompressOptions | number): Uint8Array;

/**
 * The decompressed size recorded in the first frame's header, `null` when the header does not
 * record it (streamed output, or `contentSize: false`), and 0 for a skippable frame.
 * Headers are untrusted input: still set `maxOutputSize`.
 */
export declare function getFrameContentSize(data: Bytes): number | null;

/**
 * A TransformStream that compresses everything written to it into one LZ4 frame.
 *
 * @example
 * const compressed = file.stream().pipeThrough(createCompressStream({ level: 9 }));
 */
export declare function createCompressStream(options?: CompressStreamOptions | number): TransformStream<Bytes, Uint8Array>;

/**
 * A TransformStream that decompresses LZ4 frames. The stream errors if the input is corrupt,
 * ends partway through a frame, or exceeds `maxOutputSize` in total.
 *
 * @example
 * const body = response.body.pipeThrough(createDecompressStream());
 */
export declare function createDecompressStream(options?: DecompressOptions): TransformStream<Bytes, Uint8Array>;

/**
 * Loads the backend ahead of time. Needed before the synchronous functions in browsers, Deno and
 * Workers; optional elsewhere.
 *
 * @param source Where to load `lz4.wasm` from (URL, path, `Response`, bytes or a compiled
 *   `WebAssembly.Module`). Ignored when the native addon is in use.
 */
export declare function init(source?: WasmSource): Promise<void>;

/** Which implementation is running: `'native'` (Node-API addon) or `'wasm'`. */
export declare function activeBackend(): BackendKind;

export { isLz4Frame } from './api.js';
export { Lz4Error, type Lz4ErrorCode } from './errors.js';
export type {
  BackendKind,
  BlockCompressOptions,
  BlockDecompressExactOptions,
  BlockDecompressMaxOptions,
  BlockDecompressOptions,
  BlockSize,
  Bytes,
  CompressOptions,
  CompressStreamOptions,
  DecompressOptions,
  WasmSource,
} from './types.js';
export { DEFAULT_LEVEL, HC_MIN_LEVEL, LZ4_VERSION, MAX_LEVEL, MIN_LEVEL } from './version.js';
