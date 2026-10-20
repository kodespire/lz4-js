// Tests run against the built package in dist/ (what users get), once per backend.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

import * as nodeEntry from '../dist/entry-node.js';
import * as wasmEntry from '../dist/entry-wasm.js';

export type Lz4 = typeof nodeEntry;

declare module 'vitest' {
  // Type parameters as declared by vitest.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    /** Same bytes as `expected` (any typed array or Buffer). Fast on large inputs, unlike toEqual. */
    toEqualBytes(expected: ArrayBufferView): R;
  }
}

const asBuffer = (v: ArrayBufferView) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

expect.extend({
  toEqualBytes(received: unknown, expected: ArrayBufferView) {
    if (!ArrayBuffer.isView(received)) {
      return { pass: false, message: () => `expected a typed array, got ${String(received)}` };
    }
    const a = asBuffer(received);
    const b = asBuffer(expected);
    if (a.equals(b)) return { pass: true, message: () => `expected bytes to differ (${a.length} bytes)` };
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return {
      pass: false,
      message: () => `bytes differ at offset ${i}: received ${a.length} bytes, expected ${b.length}` +
        (i < a.length && i < b.length ? ` (0x${a[i]!.toString(16)} vs 0x${b[i]!.toString(16)})` : ''),
    };
  },
});

export const backends: [[name: 'native', api: Lz4], [name: 'wasm', api: Lz4]] = [
  ['native', nodeEntry],
  ['wasm', wasmEntry as Lz4],
];

const fixturesDir = join(import.meta.dirname, 'fixtures');
export const fixturePath = (name: string): string => join(fixturesDir, name);
export const fixture = (name: string): Buffer => readFileSync(fixturePath(name));

const cliCandidate = process.env['LZ4_CLI'] ?? join(import.meta.dirname, '..', 'out', 'lz4-cli', 'programs', 'lz4');
/** Path to the official lz4 CLI, if built (`node scripts/build-lz4-cli.mjs`). */
export const lz4Cli: string | undefined = existsSync(cliCandidate) ? cliCandidate : undefined;

/** Deterministic pseudo-random bytes (incompressible). */
export function randomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Deterministic, moderately compressible bytes. */
export function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'lz4 ', 'frame ', 'block ', '\n'];
  const out = new Uint8Array(length);
  const r = randomBytes(length, seed);
  let i = 0;
  let k = 0;
  while (i < length) {
    const w = words[r[k++ % length]! % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

/** A skippable frame (magic 0x184D2A5?) carrying `payload`. */
export function skippableFrame(payload: Uint8Array, nibble = 0): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x184d2a50 + nibble, true);
  view.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

const LEGACY_MAGIC = 0x184c2102;

/** The raw blocks inside a legacy-format (`lz4 -l`) file: magic, then [u32 size, block]*. */
export function legacyBlocks(data: Uint8Array): Uint8Array[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== LEGACY_MAGIC) throw new Error('not a legacy lz4 file');
  const blocks: Uint8Array[] = [];
  for (let pos = 4; pos < data.length;) {
    const size = view.getUint32(pos, true);
    blocks.push(data.subarray(pos + 4, pos + 4 + size));
    pos += 4 + size;
  }
  return blocks;
}

/** Wraps raw blocks (each decoding to at most 8 MiB) in a legacy-format file the CLI can read. */
export function legacyFile(...blocks: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array(4)];
  new DataView(parts[0]!.buffer).setUint32(0, LEGACY_MAGIC, true);
  for (const block of blocks) {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, block.length, true);
    parts.push(size, block);
  }
  return concat(...parts);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Runs bytes through a TransformStream, writing them in the given chunk sizes. */
export async function pipeChunks(
  stream: TransformStream<Uint8Array, Uint8Array>,
  data: Uint8Array,
  chunkSizes: (i: number) => number = () => 65536,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for await (const part of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  })();
  const writer = stream.writable.getWriter();
  try {
    for (let offset = 0, i = 0; offset < data.length; i++) {
      const size = Math.max(1, chunkSizes(i));
      await writer.write(data.subarray(offset, offset + size));
      offset += size;
    }
    await writer.close();
  } catch (error) {
    await reading.catch(() => {});
    throw error;
  }
  await reading;
  return concat(...parts);
}

/** Resolves to the Lz4Error code thrown by fn, or 'no error'. */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}

export function syncErrorCode(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `uncoded ${String(error)}`;
  }
}
