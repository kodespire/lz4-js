import type { Backend, BackendProvider, WasmSource } from './types.js';
import { instantiateWasmBackend, instantiateWasmBackendSync } from './wasm-backend.js';

export function createWasmProvider(
  compile: (source?: WasmSource) => Promise<WebAssembly.Module>,
  compileSync: () => WebAssembly.Module,
): BackendProvider {
  let backend: Backend | undefined;
  let pending: Promise<Backend> | undefined;

  function load(source?: WasmSource): Promise<Backend> {
    pending ??= compile(source)
      .then(instantiateWasmBackend)
      .then(
        (b) => (backend ??= b),
        (error: unknown) => {
          pending = undefined; // allow a retry, e.g. init() with an explicit source
          throw error;
        },
      );
    return pending;
  }

  return {
    ready: () => backend,
    get: () => (backend ? Promise.resolve(backend) : load()),
    getSync: () => (backend ??= instantiateWasmBackendSync(compileSync())),
    init: async (source) => {
      if (!backend) await load(source);
    },
    kind: () => 'wasm',
  };
}
