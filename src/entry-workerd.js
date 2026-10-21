// Cloudflare Workers entry. Workers cannot compile WebAssembly from bytes at
// runtime, so the module is imported statically and bundled by wrangler.
// Copied to dist/ as-is; types come from public.d.ts.
// Keep the export list in sync with entry-wasm.ts, entry-node.ts and entry-react-native.ts.
import wasmModule from './lz4.wasm';

import { createApi } from './api.js';
import { compileFrom } from './wasm-source.js';
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
} = createApi(
  createWasmProvider(
    (source) => compileFrom(source ?? wasmModule),
    () => wasmModule,
  ),
);

export { isLz4Frame } from './api.js';
export { Lz4Error } from './errors.js';
export { DEFAULT_LEVEL, HC_MIN_LEVEL, LZ4_VERSION, MAX_LEVEL, MIN_LEVEL } from './version.js';
