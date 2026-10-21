// React Native backend: the C++ TurboModule in cpp/ (the ljs C layer, as in the
// Node-API addon), reached through JSI. It returns ArrayBuffers that own the
// native output, and throws or rejects with errors carrying `ljsCode`.
import { rethrowNative } from './errors.js';
import type { Backend, CStreamHandle, DStreamHandle } from './types.js';

interface NativeCStream {
  push(chunk: Uint8Array, mode: number): ArrayBuffer;
  pushAsync(chunk: Uint8Array, mode: number): Promise<ArrayBuffer>;
  close(): void;
}

interface NativeDStream {
  push(chunk: Uint8Array): ArrayBuffer;
  pushAsync(chunk: Uint8Array): Promise<ArrayBuffer>;
  finish(): void;
  close(): void;
}

/** @internal What cpp/KodespireLz4Module.cpp exposes. */
export interface NativeModule {
  version(): string;
  compressSync(data: Uint8Array, level: number, blockSize: number, flags: number, dict: Uint8Array | null): ArrayBuffer;
  compress(data: Uint8Array, level: number, blockSize: number, flags: number, dict: Uint8Array | null): Promise<ArrayBuffer>;
  decompressSync(data: Uint8Array, dict: Uint8Array | null, maxOutput: number): ArrayBuffer;
  decompress(data: Uint8Array, dict: Uint8Array | null, maxOutput: number): Promise<ArrayBuffer>;
  compressBlockSync(data: Uint8Array, level: number, dict: Uint8Array | null): ArrayBuffer;
  compressBlock(data: Uint8Array, level: number, dict: Uint8Array | null): Promise<ArrayBuffer>;
  decompressBlockSync(data: Uint8Array, dict: Uint8Array | null, size: number, exact: boolean): ArrayBuffer;
  decompressBlock(data: Uint8Array, dict: Uint8Array | null, size: number, exact: boolean): Promise<ArrayBuffer>;
  frameContentSize(data: Uint8Array): number;
  createCStream(level: number, blockSize: number, flags: number, dict: Uint8Array | null): NativeCStream;
  createDStream(dict: Uint8Array | null, maxOutput: number): NativeDStream;
}

const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

function wrapSync<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      rethrowNative(error);
    }
  };
}

export function createJsiBackend(m: NativeModule): Backend {
  return {
    kind: 'native',
    version: m.version(),
    compressSync: wrapSync((data, level, blockSize, flags, dict) =>
      bytes(m.compressSync(data, level, blockSize, flags, dict))),
    compress: (data, level, blockSize, flags, dict) =>
      m.compress(data, level, blockSize, flags, dict).then(bytes, rethrowNative),
    decompressSync: wrapSync((data, dict, maxOutput) => bytes(m.decompressSync(data, dict, maxOutput))),
    decompress: (data, dict, maxOutput) => m.decompress(data, dict, maxOutput).then(bytes, rethrowNative),
    compressBlockSync: wrapSync((data, level, dict) => bytes(m.compressBlockSync(data, level, dict))),
    compressBlock: (data, level, dict) => m.compressBlock(data, level, dict).then(bytes, rethrowNative),
    decompressBlockSync: wrapSync((data, dict, size, exact) =>
      bytes(m.decompressBlockSync(data, dict, size, exact))),
    decompressBlock: (data, dict, size, exact) =>
      m.decompressBlock(data, dict, size, exact).then(bytes, rethrowNative),
    frameContentSize: wrapSync((data) => m.frameContentSize(data)),
    // The stream methods are plain functions bound to their native context.
    createCStream: wrapSync((level, blockSize, flags, dict): CStreamHandle => {
      const { push, pushAsync, close } = m.createCStream(level, blockSize, flags, dict);
      return {
        push: wrapSync((chunk, mode) => bytes(push(chunk, mode))),
        pushAsync: (chunk, mode) => pushAsync(chunk, mode).then(bytes, rethrowNative),
        close: wrapSync(() => close()),
      };
    }),
    createDStream: wrapSync((dict, maxOutput): DStreamHandle => {
      const { push, pushAsync, finish, close } = m.createDStream(dict, maxOutput);
      return {
        push: wrapSync((chunk) => bytes(push(chunk))),
        pushAsync: (chunk) => pushAsync(chunk).then(bytes, rethrowNative),
        finish: wrapSync(() => finish()),
        close: wrapSync(() => close()),
      };
    }),
  };
}
