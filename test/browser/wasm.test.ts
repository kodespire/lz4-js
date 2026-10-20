// Runs in real browsers (see vitest.browser.config.ts) against the built dist/.
import { describe, expect, it } from 'vitest';

import * as z from '../../dist/entry-wasm.js';

const text = (n: number) => new TextEncoder().encode('browser lz4 test '.repeat(Math.ceil(n / 17))).subarray(0, n);

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, data: Uint8Array, chunk: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  for (let i = 0; i < data.length; i += chunk) await writer.write(data.subarray(i, i + chunk));
  await writer.close();
  await reading;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('lz4-js in the browser', () => {
  // Must run first: nothing has loaded the module yet.
  it('sync calls before init() throw ERR_LZ4_NOT_INITIALIZED', () => {
    expect(() => z.compressSync('x')).toThrow(expect.objectContaining({ code: 'ERR_LZ4_NOT_INITIALIZED' }));
    expect(() => z.compressBlockSync('x')).toThrow(expect.objectContaining({ code: 'ERR_LZ4_NOT_INITIALIZED' }));
  });

  it('async calls load the WebAssembly module on demand, reading their input before they return', async () => {
    const src = text(500_000);
    const original = src.slice();
    const pending = z.compress(src, 9); // the module is still loading
    src.fill(0);
    const frame = await pending;
    expect(frame.length).toBeLessThan(5_000);
    expect(equal(await z.decompress(frame), original)).toBe(true);
    expect(z.activeBackend()).toBe('wasm');
  });

  it('sync calls work after init()', async () => {
    await z.init();
    const src = text(100_000);
    expect(equal(z.decompressSync(z.compressSync(src)), src)).toBe(true);
    expect(z.getFrameContentSize(z.compressSync(src))).toBe(100_000);
    expect(equal(z.decompressBlockSync(z.compressBlockSync(src, 12), src.length), src)).toBe(true);
  });

  it('truncated input is an error', async () => {
    const frame = await z.compress(new Uint8Array(1_000_000));
    await expect(z.decompress(frame.subarray(0, frame.length - 3))).rejects.toMatchObject({ code: 'ERR_LZ4_TRUNCATED' });
    const block = await z.compressBlock(text(10_000));
    await expect(z.decompressBlock(block.subarray(0, block.length - 1), 10_000)).rejects.toMatchObject({ code: expect.stringMatching(/^ERR_LZ4_/) });
  });

  it('maxOutputSize is enforced', async () => {
    const frame = await z.compress(new Uint8Array(8 << 20));
    await expect(z.decompress(frame, { maxOutputSize: 1 << 20 })).rejects.toMatchObject({ code: 'ERR_LZ4_OUTPUT_LIMIT' });
  });

  it('streams round-trip', async () => {
    const src = text(2_000_000);
    const frame = await pipe(z.createCompressStream({ level: 5 }), src, 100_000);
    expect(z.getFrameContentSize(frame)).toBeNull();
    expect(equal(await pipe(z.createDecompressStream(), frame, 777), src)).toBe(true);
  });

  it('grows WebAssembly memory past 256 MiB and keeps working', async () => {
    const src = new Uint8Array(300 << 20);
    src[src.length - 1] = 7;
    const frame = await z.compress(src, 1);
    const out = await z.decompress(frame);
    expect(out.length).toBe(src.length);
    expect(out[out.length - 1]).toBe(7);
    expect(z.decompressSync(z.compressSync('still fine'))).toEqual(new TextEncoder().encode('still fine'));
  });
});
