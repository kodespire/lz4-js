// Loads lz4.wasm from disk. Selected by the "node" condition of the "#load-wasm" import.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { WasmSource } from './types.js';
import { compileFrom } from './wasm-source.js';

const DEFAULT_URL = new URL('./lz4.wasm', import.meta.url);

function toUrl(location: URL | string): URL {
  if (location instanceof URL) return location;
  return isAbsolute(location) ? pathToFileURL(location) : new URL(location);
}

export async function compileWasm(source?: WasmSource): Promise<WebAssembly.Module> {
  const s = source ?? DEFAULT_URL;
  if (s instanceof URL || typeof s === 'string') {
    const url = toUrl(s);
    if (url.protocol === 'file:') return WebAssembly.compile(await readFile(url));
    return compileFrom(fetch(url));
  }
  return compileFrom(s);
}

export function compileWasmSync(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(DEFAULT_URL));
}
