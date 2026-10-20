// Node.js and Bun entry: the native addon, falling back to WebAssembly when no
// prebuilt binary matches this platform. Set LZ4_JS_BACKEND=wasm to force WebAssembly.
// Keep the export list in sync with entry-wasm.ts and entry-workerd.js.
import { createApi } from './api.js';
import { compileWasm, compileWasmSync } from './load-wasm-node.js';
import { loadNativeBackend } from './native-backend.js';
import type { Backend, BackendProvider } from './types.js';
import { createWasmProvider } from './wasm-provider.js';

const wasm = createWasmProvider(compileWasm, compileWasmSync);
let native: Backend | undefined;
let nativeUnavailable = process.env['LZ4_JS_BACKEND'] === 'wasm';

function tryNative(): Backend | undefined {
  if (native || nativeUnavailable) return native;
  try {
    native = loadNativeBackend();
  } catch {
    nativeUnavailable = true;
  }
  return native;
}

const provider: BackendProvider = {
  ready: () => tryNative() ?? wasm.ready(),
  get: async () => tryNative() ?? wasm.get(),
  getSync: () => tryNative() ?? wasm.getSync(),
  init: async (source) => {
    if (!tryNative()) await wasm.init(source);
  },
  kind: () => (tryNative() ? 'native' : 'wasm'),
};

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
} = createApi(provider);

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
