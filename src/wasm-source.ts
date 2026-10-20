import type { WasmSource } from './types.js';

function isResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response;
}

/** Compiles a module from anything except a URL or path (those are loader-specific). */
export async function compileFrom(source: Exclude<WasmSource, URL | string>): Promise<WebAssembly.Module> {
  const resolved = await source;
  if (resolved instanceof WebAssembly.Module) return resolved;
  if (isResponse(resolved)) {
    if (!resolved.ok) throw new Error(`failed to load lz4.wasm: HTTP ${resolved.status} ${resolved.statusText}`);
    const type = resolved.headers.get('content-type') ?? '';
    if (typeof WebAssembly.compileStreaming === 'function' && type.startsWith('application/wasm')) {
      return WebAssembly.compileStreaming(resolved);
    }
    return WebAssembly.compile(await resolved.arrayBuffer());
  }
  if (ArrayBuffer.isView(resolved)) {
    return WebAssembly.compile(new Uint8Array(resolved.buffer, resolved.byteOffset, resolved.byteLength) as Uint8Array<ArrayBuffer>);
  }
  return WebAssembly.compile(resolved as ArrayBuffer);
}
