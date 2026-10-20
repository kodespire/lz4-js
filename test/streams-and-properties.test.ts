import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { backends, concat, errorCode, pipeChunks, randomBytes, textBytes } from './helpers.js';

describe.each(backends)('%s backend: streams', (_name, z) => {
  it('compress stream output decodes with one-shot decompress, for many chunk sizes', async () => {
    const src = textBytes(1_000_000, 21);
    for (const chunk of [1_000, 64 * 1024, 131_072, 300_000, 2_000_000]) {
      const frame = await pipeChunks(z.createCompressStream(), src, () => chunk);
      expect(z.decompressSync(frame), `chunk ${chunk}`).toEqualBytes(src);
    }
  });

  it('a compress stream with no input gives a valid empty frame', async () => {
    const frame = await pipeChunks(z.createCompressStream(), new Uint8Array(0));
    expect(z.isLz4Frame(frame)).toBe(true);
    expect(z.decompressSync(frame)).toEqualBytes(new Uint8Array(0));
  });

  it('decompress stream handles input split at every kind of boundary', async () => {
    const src = textBytes(400_000, 22);
    const frame = z.compressSync(src, { level: 7, blockChecksum: true });
    for (const chunk of [1, 3, 4096, 65_536, frame.length]) {
      const out = await pipeChunks(z.createDecompressStream(), frame, () => chunk);
      expect(out, `chunk ${chunk}`).toEqualBytes(src);
    }
  });

  it('decompress stream handles concatenated frames split mid-frame', async () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(50_000, 2);
    const data = concat(z.compressSync(a), z.compressSync(b));
    expect(await pipeChunks(z.createDecompressStream(), data, () => 999)).toEqualBytes(concat(a, b));
  });

  it('decompress stream errors on input that ends mid-frame', async () => {
    const frame = z.compressSync(textBytes(100_000, 3));
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), frame.subarray(0, frame.length - 1)))).toBe('ERR_LZ4_TRUNCATED');
  });

  it('decompress stream errors when no input arrives at all', async () => {
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), new Uint8Array(0)))).toBe('ERR_LZ4_TRUNCATED');
  });

  it('decompress stream enforces maxOutputSize across chunks', async () => {
    const frame = z.compressSync(new Uint8Array(5 << 20));
    expect(await errorCode(() => pipeChunks(z.createDecompressStream({ maxOutputSize: 1 << 20 }), frame, () => 10)))
      .toBe('ERR_LZ4_OUTPUT_LIMIT');
    expect((await pipeChunks(z.createDecompressStream({ maxOutputSize: 5 << 20 }), frame, () => 10)).length).toBe(5 << 20);
  });

  it('decompress stream errors on corrupt input', async () => {
    const frame = z.compressSync(textBytes(100_000, 4));
    frame[frame.length >> 1]! ^= 0xff;
    expect(await errorCode(() => pipeChunks(z.createDecompressStream(), frame))).not.toBe('no error');
  });

  it('streams with a dictionary, across concatenated frames', async () => {
    // liblz4 forgets the dictionary at the end of each frame; the next frame must get it again.
    const dictionary = textBytes(8_000, 5);
    const src = textBytes(50_000, 5);
    const frame = await pipeChunks(z.createCompressStream({ dictionary }), src);
    const two = concat(frame, z.compressSync(src, { dictionary, level: 9 }));
    expect(z.decompressSync(two, { dictionary })).toEqualBytes(concat(src, src));
    expect(await pipeChunks(z.createDecompressStream({ dictionary }), two, () => 100)).toEqualBytes(concat(src, src));
  });

  it('the dictionary is copied: changing the caller’s buffer mid-stream has no effect', async () => {
    const dictionary = textBytes(8_000, 6);
    const src = textBytes(20_000, 6);
    const frame = z.compressSync(src, { dictionary });
    const mutable = dictionary.slice();
    const stream = z.createDecompressStream({ dictionary: mutable });
    const writer = stream.writable.getWriter();
    const reading = (async () => {
      const parts: Uint8Array[] = [];
      for await (const p of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
      return concat(...parts);
    })();
    await writer.write(frame.subarray(0, 10));
    mutable.fill(0);
    await writer.write(frame.subarray(10));
    await writer.close();
    expect(await reading).toEqualBytes(src);
  });

  it('cancelling a stream while a chunk is being processed is clean', async () => {
    const big = textBytes(16 << 20, 31);
    const frame = z.compressSync(big, 1);
    const cases: [TransformStream<Uint8Array, Uint8Array>, Uint8Array][] = [
      [z.createCompressStream(12), big],
      [z.createDecompressStream(), frame],
    ];
    for (const [stream, chunk] of cases) {
      // transform() only runs once the readable side has demand, so read first.
      const reader = stream.readable.getReader();
      const read = reader.read().catch(() => {});
      const pending = stream.writable.getWriter().write(chunk).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5)); // the push is now in flight
      await expect(reader.cancel('stop')).resolves.toBeUndefined();
      await Promise.all([read, pending]);
    }
    // The backend still works afterwards.
    expect(z.decompressSync(z.compressSync('after cancel'))).toEqualBytes(new TextEncoder().encode('after cancel'));
  });

  it('many concurrent async calls return the right results', async () => {
    const inputs = Array.from({ length: 64 }, (_, i) => textBytes(20_000 + i * 997, i));
    const frames = await Promise.all(inputs.map((src, i) => z.compress(src, (i % 12) + 1)));
    const blocks = await Promise.all(inputs.map((src, i) => z.compressBlock(src, (i % 12) + 1)));
    const outputs = await Promise.all(frames.map((f) => z.decompress(f)));
    const blockOutputs = await Promise.all(blocks.map((b, i) => z.decompressBlock(b, inputs[i]!.length)));
    outputs.forEach((out, i) => expect(out).toEqualBytes(inputs[i]!));
    blockOutputs.forEach((out, i) => expect(out).toEqualBytes(inputs[i]!));
  });

  it('async calls copy their input: changing it after the call has no effect', async () => {
    const src = textBytes(2 << 20, 41);
    const copy = src.slice();
    const pending = z.compress(src);
    src.fill(0);
    expect(z.decompressSync(await pending)).toEqualBytes(copy);
  });
});

describe.each(backends)('%s backend: properties', (_name, z) => {
  it('decompress(compress(x)) === x for arbitrary bytes and options', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 20_000 }),
        fc.integer({ min: -20, max: 12 }),
        fc.record({
          contentChecksum: fc.boolean(),
          blockChecksum: fc.boolean(),
          contentSize: fc.boolean(),
          blockSize: fc.constantFrom(65536 as const, 262144 as const),
        }),
        (src, level, options) => {
          expect(z.decompressSync(z.compressSync(src, { level, ...options }))).toEqualBytes(src);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('decompressBlock(compressBlock(x)) === x for arbitrary bytes and levels', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 20_000 }), fc.integer({ min: -20, max: 12 }), (src, level) => {
        expect(z.decompressBlockSync(z.compressBlockSync(src, level), src.length)).toEqualBytes(src);
      }),
      { numRuns: 300 },
    );
  });

  it('chunked streaming matches one-shot for arbitrary splits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 200_000 }).map((a) => a.map((b, i) => (i % 4 ? b & 0x0f : b))),
        fc.array(fc.integer({ min: 1, max: 70_000 }), { minLength: 1, maxLength: 20 }),
        async (src, sizes) => {
          const frame = await pipeChunks(z.createCompressStream(), src, (i) => sizes[i % sizes.length]!);
          expect(z.decompressSync(frame)).toEqualBytes(src);
          const out = await pipeChunks(z.createDecompressStream(), frame, (i) => sizes[(i + 1) % sizes.length]!);
          expect(out).toEqualBytes(src);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('arbitrary bytes never crash the frame decoder', () => {
    const frame = z.compressSync(textBytes(3000, 50), { contentChecksum: false });
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 3000 }), fc.nat({ max: 200 }), (noise, at) => {
        // Valid header followed by noise, so the decoder gets past the magic number.
        const data = concat(frame.subarray(0, Math.min(at, frame.length)), noise);
        try {
          expect(z.decompressSync(data, { maxOutputSize: 1 << 20 }).length).toBeLessThanOrEqual(1 << 20);
        } catch (error) {
          expect((error as { code?: string }).code).toMatch(/^ERR_LZ4_/);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('native and wasm agree', () => {
  const [[, native], [, wasm]] = backends;

  it('each decodes the other’s output', async () => {
    for (const level of [-3, 1, 2, 9, 12]) {
      const src = textBytes(300_000, level + 50);
      expect(wasm.decompressSync(native.compressSync(src, { level }))).toEqualBytes(src);
      expect(native.decompressSync(wasm.compressSync(src, { level }))).toEqualBytes(src);
      const streamed = await pipeChunks(native.createCompressStream({ level }), src, () => 50_000);
      expect(await pipeChunks(wasm.createDecompressStream(), streamed, () => 1234)).toEqualBytes(src);
    }
  });

  it('report the same lz4 version as the bundled source', () => {
    expect(native.LZ4_VERSION).toBe(wasm.LZ4_VERSION);
  });
});
