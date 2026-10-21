// WebAssembly entry: browsers, Deno, and anything without the native addon.
// Keep the export list in sync with entry-node.ts, entry-workerd.js and entry-react-native.ts.
import { compileWasm, compileWasmSync } from '#load-wasm';

import { createApi } from './api.js';
import { createWasmProvider } from './wasm-provider.js';

export const {
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
} = createApi(createWasmProvider(compileWasm, compileWasmSync));

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
