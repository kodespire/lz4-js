import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): Uint8Array;
  pushAsync(chunk: Uint8Array, mode: number): Promise<Uint8Array>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): Uint8Array;
  pushAsync(chunk: Uint8Array): Promise<Uint8Array>;
  finish(): void;
  close(): void;
}

interface NativeAddon {
  version: string;
  compressSync(data: Uint8Array, level: number, blockSize: number, flags: number, dict: Uint8Array | null): Uint8Array;
  compress(data: Uint8Array, level: number, blockSize: number, flags: number, dict: Uint8Array | null): Promise<Uint8Array>;
  decompressSync(data: Uint8Array, dict: Uint8Array | null, maxOutput: number): Uint8Array;
  decompress(data: Uint8Array, dict: Uint8Array | null, maxOutput: number): Promise<Uint8Array>;
  compressBlockSync(data: Uint8Array, level: number, dict: Uint8Array | null): Uint8Array;
  compressBlock(data: Uint8Array, level: number, dict: Uint8Array | null): Promise<Uint8Array>;
  decompressBlockSync(data: Uint8Array, dict: Uint8Array | null, size: number, exact: boolean): Uint8Array;
  decompressBlock(data: Uint8Array, dict: Uint8Array | null, size: number, exact: boolean): Promise<Uint8Array>;
  frameContentSize(data: Uint8Array): number;
  CStream: new (level: number, blockSize: number, flags: number, dict: Uint8Array | null) => NativeCStream;
  DStream: new (dict: Uint8Array | null, maxOutput: number) => NativeDStream;
}

// The addon returns Node Buffers; expose plain Uint8Array views (no copy) so results
// behave the same in every runtime.
const view = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

/** Loads the prebuilt (or locally built) addon. Throws if none matches this platform. */
export function loadNativeBackend(): Backend {
  const require = createRequire(import.meta.url);
  const nodeGypBuild = require('node-gyp-build') as (dir: string) => NativeAddon;
  const addon = nodeGypBuild(fileURLToPath(new URL('..', import.meta.url)));

  return {
    kind: 'native',
    version: addon.version,
    compressSync: wrapSync((data, level, blockSize, flags, dict) =>
      view(addon.compressSync(data, level, blockSize, flags, dict))),
    compress: (data, level, blockSize, flags, dict) =>
      addon.compress(data, level, blockSize, flags, dict).then(view, rethrowNative),
    decompressSync: wrapSync((data, dict, maxOutput) => view(addon.decompressSync(data, dict, maxOutput))),
    decompress: (data, dict, maxOutput) => addon.decompress(data, dict, maxOutput).then(view, rethrowNative),
    compressBlockSync: wrapSync((data, level, dict) => view(addon.compressBlockSync(data, level, dict))),
    compressBlock: (data, level, dict) => addon.compressBlock(data, level, dict).then(view, rethrowNative),
    decompressBlockSync: wrapSync((data, dict, size, exact) =>
      view(addon.decompressBlockSync(data, dict, size, exact))),
    decompressBlock: (data, dict, size, exact) =>
      addon.decompressBlock(data, dict, size, exact).then(view, rethrowNative),
    frameContentSize: wrapSync((data) => addon.frameContentSize(data)),
    createCStream: wrapSync((level, blockSize, flags, dict): CStreamHandle => {
      const s = new addon.CStream(level, blockSize, flags, dict);
      return {
        push: wrapSync((chunk, mode) => view(s.push(chunk, mode))),
        pushAsync: (chunk, mode) => s.pushAsync(chunk, mode).then(view, rethrowNative),
        close: wrapSync(() => s.close()),
      };
    }),
    createDStream: wrapSync((dict, maxOutput): DStreamHandle => {
      const s = new addon.DStream(dict, maxOutput);
      return {
        push: wrapSync((chunk) => view(s.push(chunk))),
        pushAsync: (chunk) => s.pushAsync(chunk).then(view, rethrowNative),
        finish: wrapSync(() => s.finish()),
        close: wrapSync(() => s.close()),
      };
    }),
  };
}
