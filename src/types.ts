/** Binary input accepted everywhere: any ArrayBuffer, typed array, DataView or Node Buffer. */
export type Bytes = ArrayBuffer | ArrayBufferView;

/** Largest block in a frame, in bytes: 64 KiB, 256 KiB, 1 MiB or 4 MiB. */
export type BlockSize = 65536 | 262144 | 1048576 | 4194304;

export interface CompressOptions {
  /**
   * Compression level, from MIN_LEVEL (-65536, fastest) to MAX_LEVEL (12, smallest). Defaults to 1.
   * Levels below 1 trade ratio for speed: level -N is `lz4 --fast=N`. 0 and 1 are the same fast
   * compressor. Levels 2 to 12 use LZ4 HC, which is much slower to compress but decodes just as fast.
   */
  level?: number;
  /** Append an XXH32 checksum of the content, so corruption is detected on decompression. Defaults to true. */
  contentChecksum?: boolean;
  /** Add an XXH32 checksum of each compressed block (4 bytes per block). Defaults to false. */
  blockChecksum?: boolean;
  /**
   * Largest block: 65536 (the default), 262144, 1048576 or 4194304 bytes. Decoders need about
   * twice this much memory. Input that fits in a smaller block size is written with that size.
   */
  blockSize?: BlockSize;
  /**
   * Record the uncompressed size in the frame header (8 bytes), so decoders can allocate
   * up front. Defaults to true. An empty input's size cannot be recorded: the format reads 0 as unknown.
   */
  contentSize?: boolean;
  /**
   * Compress with a dictionary: any bytes similar to the data. Only the last 64 KiB is used.
   * The same dictionary is required to decompress.
   */
  dictionary?: Bytes;
}

/** Options for {@link createCompressStream}: a stream never knows its total size, so there is no `contentSize`. */
export type CompressStreamOptions = Omit<CompressOptions, 'contentSize'>;

export interface DecompressOptions {
  /**
   * Throw ERR_LZ4_OUTPUT_LIMIT instead of producing more than this many bytes.
   * Set it whenever the input is untrusted. Defaults to Infinity.
   */
  maxOutputSize?: number;
  /** Dictionary the data was compressed with. */
  dictionary?: Bytes;
}

export interface BlockCompressOptions {
  /** Compression level, as for {@link CompressOptions.level}. Defaults to 1. */
  level?: number;
  /** Compress with a dictionary (its last 64 KiB). The same dictionary is required to decompress. */
  dictionary?: Bytes;
}

/** Decompress a raw block whose exact original size is known (the safe choice). */
export interface BlockDecompressExactOptions {
  /**
   * The exact size of the original data. A block that decodes to fewer bytes throws
   * ERR_LZ4_TRUNCATED and one that decodes to more throws ERR_LZ4_OUTPUT_LIMIT.
   */
  originalSize: number;
  maxOutputSize?: never;
  /** Dictionary the block was compressed with. */
  dictionary?: Bytes;
}

/** Decompress a raw block whose original size is only known not to exceed a limit. */
export interface BlockDecompressMaxOptions {
  /**
   * Upper bound on the original size: ERR_LZ4_OUTPUT_LIMIT if the block decodes to more.
   * Raw blocks have no end marker, so a block cut off right after a run of literals decodes
   * to a shorter result without an error. Use `originalSize` when you know it.
   */
  maxOutputSize: number;
  originalSize?: never;
  /** Dictionary the block was compressed with. */
  dictionary?: Bytes;
}

/** Exactly one of `originalSize` or `maxOutputSize`: a raw block does not record its size. */
export type BlockDecompressOptions = BlockDecompressExactOptions | BlockDecompressMaxOptions;

/** Where the WebAssembly module comes from, for `init()`. */
export type WasmSource =
  | WebAssembly.Module
  | Bytes
  | URL
  | string
  | Response
  | PromiseLike<Response>;

export type BackendKind = 'native' | 'wasm';

/** @internal Mode values match LJS_MODE_* in csrc/ljs.h. */
export const MODE_CONTINUE = 0;
/** @internal */
export const MODE_END = 2;

/** @internal Frame flags, matching LJS_FLAG_* in csrc/ljs.h. */
export const FLAG_CONTENT_CHECKSUM = 1;
/** @internal */
export const FLAG_BLOCK_CHECKSUM = 2;
/** @internal */
export const FLAG_CONTENT_SIZE = 4;

/** @internal */
export interface CStreamHandle {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

/** @internal */
export interface DStreamHandle {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

/** @internal What each backend (native addon, WebAssembly) implements. Errors are Lz4Error. */
export interface Backend {
  readonly kind: BackendKind;
  readonly version: string;
  compressSync(data: Uint8Array, level: number, blockSize: number, flags: number, dict: Uint8Array | null): Uint8Array;
  compress(data: Uint8Array, level: number, blockSize: number, flags: number, dict: Uint8Array | null): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, dict: Uint8Array | null, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, dict: Uint8Array | null, maxOutput: number): Promise<Uint8Array>;
  compressBlockSync(data: Uint8Array, level: number, dict: Uint8Array | null): Uint8Array;
  compressBlock(data: Uint8Array, level: number, dict: Uint8Array | null): Promise<Uint8Array>;
  decompressBlockSync(data: Uint8Array, dict: Uint8Array | null, size: number, exact: boolean): Uint8Array;
  decompressBlock(data: Uint8Array, dict: Uint8Array | null, size: number, exact: boolean): Promise<Uint8Array>;
  /** -1 when the frame header does not record the size. */
  frameContentSize(data: Uint8Array): number;
  createCStream(level: number, blockSize: number, flags: number, dict: Uint8Array | null): CStreamHandle;
  createDStream(dict: Uint8Array | null, maxOutput: number): DStreamHandle;
}

/** @internal How an entry point supplies its backend to the public API. */
export interface BackendProvider {
  get(): Promise<Backend>;
  getSync(): Backend;
  init(source?: WasmSource): Promise<void>;
  kind(): BackendKind;
}
