export type Lz4ErrorCode =
  /** liblz4 rejected the data: corrupt input, wrong dictionary, checksum mismatch, and so on. */
  | 'ERR_LZ4_LIBRARY'
  /** The input ended before the end of a frame, or was empty; or a block decoded to less than `originalSize`. */
  | 'ERR_LZ4_TRUNCATED'
  /** Decompressed output would exceed `maxOutputSize` (or a block's `originalSize`). */
  | 'ERR_LZ4_OUTPUT_LIMIT'
  | 'ERR_LZ4_OUT_OF_MEMORY'
  | 'ERR_LZ4_INVALID_ARGUMENT'
  /** A synchronous call was made before the WebAssembly module was loaded with `init()`. */
  | 'ERR_LZ4_NOT_INITIALIZED';

export class Lz4Error extends Error {
  readonly code: Lz4ErrorCode;

  constructor(code: Lz4ErrorCode, message: string) {
    super(message);
    this.name = 'Lz4Error';
    this.code = code;
  }
}

// Indexed by the LJS_ERR_* values in csrc/ljs.h.
const CODES: readonly (Lz4ErrorCode | undefined)[] = [
  undefined,
  'ERR_LZ4_LIBRARY',
  'ERR_LZ4_TRUNCATED',
  'ERR_LZ4_OUTPUT_LIMIT',
  'ERR_LZ4_OUT_OF_MEMORY',
  'ERR_LZ4_INVALID_ARGUMENT',
];

export function errorFromCore(rc: number, detail: string): Lz4Error {
  const code = CODES[rc] ?? 'ERR_LZ4_LIBRARY';
  return new Lz4Error(code, code === 'ERR_LZ4_LIBRARY' ? `lz4: ${detail}` : detail);
}

/** Converts an error thrown by the native addon into an Lz4Error with a JavaScript stack. */
export function rethrowNative(error: unknown): never {
  if (error !== null && typeof error === 'object' && typeof (error as { ljsCode?: unknown }).ljsCode === 'number') {
    throw errorFromCore((error as { ljsCode: number }).ljsCode, (error as Error).message);
  }
  throw error;
}
