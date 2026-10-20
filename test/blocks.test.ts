// The raw block format: no header, no size, no checksum, no end marker. The
// caller supplies the size, and these tests pin down what each kind of size
// can and cannot catch. Every case runs on both backends.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { backends, errorCode, fixture, randomBytes, syncErrorCode, textBytes } from './helpers.js';

const SIZES = [0, 1, 2, 12, 13, 65535, 65536, 65537, 262145, 1 << 20, (4 << 20) + 1];

/** True if `out` is a prefix of `src` (possibly all of it). */
const isPrefix = (out: Uint8Array, src: Uint8Array) => out.length <= src.length && out.every((b, i) => b === src[i]);

describe.each(backends)('%s backend: raw blocks', (_name, z) => {
  it.each(SIZES)('round trip with originalSize and with maxOutputSize, %i bytes', async (size) => {
    const src = textBytes(size, size + 3);
    for (const level of [1, 9]) {
      const block = z.compressBlockSync(src, level);
      expect(z.decompressBlockSync(block, size)).toEqualBytes(src);
      expect(z.decompressBlockSync(block, { originalSize: size })).toEqualBytes(src);
      expect(await z.decompressBlock(block, { maxOutputSize: size })).toEqualBytes(src);
      expect(z.decompressBlockSync(block, { maxOutputSize: size + 1000 })).toEqualBytes(src);
      if (size > 0) {
        expect(syncErrorCode(() => z.decompressBlockSync(block, { maxOutputSize: size - 1 }))).toBe('ERR_LZ4_OUTPUT_LIMIT');
        expect(syncErrorCode(() => z.decompressBlockSync(block, size - 1))).toBe('ERR_LZ4_OUTPUT_LIMIT');
      }
      expect(syncErrorCode(() => z.decompressBlockSync(block, size + 1))).toBe('ERR_LZ4_TRUNCATED');
    }
  });

  it('a block has no frame around it', () => {
    const src = textBytes(10_000, 1);
    const block = z.compressBlockSync(src);
    expect(z.isLz4Frame(block)).toBe(false);
    expect(block.length).toBeLessThan(z.compressSync(src).length);
    expect(syncErrorCode(() => z.decompressSync(block))).toBe('ERR_LZ4_LIBRARY');
  });

  it('the empty input compresses to a one-byte block', () => {
    const block = z.compressBlockSync(new Uint8Array(0));
    expect(block).toEqualBytes(new Uint8Array([0]));
    expect(z.decompressBlockSync(block, 0)).toEqualBytes(new Uint8Array(0));
    expect(syncErrorCode(() => z.decompressBlockSync(new Uint8Array(0), 0))).toBe('ERR_LZ4_TRUNCATED');
  });

  it('with originalSize, every proper prefix of a block is rejected', () => {
    const src = textBytes(5000, 4);
    for (const level of [-3, 1, 9, 12]) {
      const block = z.compressBlockSync(src, level);
      for (let cut = 0; cut < block.length; cut++) {
        const code = syncErrorCode(() => z.decompressBlockSync(block.subarray(0, cut), src.length));
        if (code === 'no error') expect.fail(`level ${level}: cut at ${cut}/${block.length} was accepted`);
      }
    }
  });

  it('with maxOutputSize, a cut block either throws or decodes to a prefix: never to wrong bytes', () => {
    // The block format has no end marker: a block cut right after a run of
    // literals is itself a valid, shorter block. This is why originalSize is
    // the safe choice.
    const src = textBytes(5000, 5);
    const block = z.compressBlockSync(src);
    let shorter = 0;
    for (let cut = 1; cut < block.length; cut++) {
      try {
        const out = z.decompressBlockSync(block.subarray(0, cut), { maxOutputSize: src.length });
        expect(isPrefix(out, src), `cut at ${cut}`).toBe(true);
        expect(out.length).toBeLessThan(src.length);
        shorter++;
      } catch (error) {
        expect((error as { code?: string }).code).toMatch(/^ERR_LZ4_/);
      }
    }
    expect(shorter).toBeGreaterThan(0); // the hazard is real, and documented
  });

  it('maxOutputSize grows the output buffer as needed', async () => {
    // 10 MiB of zeros is a ~40 KB block: far beyond the initial guess.
    const src = new Uint8Array(10 << 20);
    src[src.length - 1] = 9;
    const block = await z.compressBlock(src);
    expect(block.length).toBeLessThan(50_000);
    expect(await z.decompressBlock(block, { maxOutputSize: 20 << 20 })).toEqualBytes(src);
    expect(await errorCode(() => z.decompressBlock(block, { maxOutputSize: (10 << 20) - 1 }))).toBe('ERR_LZ4_OUTPUT_LIMIT');
  });

  it('a size no block of this length can reach fails fast, without allocating it', () => {
    const tiny = z.compressBlockSync('abc');
    const started = performance.now();
    expect(syncErrorCode(() => z.decompressBlockSync(tiny, 2_000_000_000))).toBe('ERR_LZ4_TRUNCATED');
    expect(z.decompressBlockSync(tiny, { maxOutputSize: 2_000_000_000 })).toEqualBytes(new TextEncoder().encode('abc'));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('corrupt blocks throw, or decode to at most the given size: never crash', () => {
    // Raw blocks carry no checksum, so some corruption decodes silently to wrong
    // bytes. What must hold is memory safety and the size contract.
    const src = textBytes(20_000, 6);
    const block = z.compressBlockSync(src);
    for (let i = 0; i < block.length; i += 7) {
      const bad = block.slice();
      bad[i]! ^= 0xa5;
      for (const options of [{ originalSize: src.length }, { maxOutputSize: src.length }]) {
        try {
          const out = z.decompressBlockSync(bad, options);
          if ('originalSize' in options) expect(out.length).toBe(src.length);
          else expect(out.length).toBeLessThanOrEqual(src.length);
        } catch (error) {
          expect((error as { code?: string }).code).toMatch(/^ERR_LZ4_(LIBRARY|TRUNCATED|OUTPUT_LIMIT)$/);
        }
      }
    }
  });

  it('arbitrary bytes never crash the block decoder', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), fc.integer({ min: 0, max: 100_000 }), fc.boolean(), (data, size, exact) => {
        try {
          const out = z.decompressBlockSync(data, exact ? { originalSize: size } : { maxOutputSize: size });
          expect(out.length).toBeLessThanOrEqual(size);
        } catch (error) {
          expect((error as { code?: string }).code).toMatch(/^ERR_LZ4_/);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('the level changes the block, and levels mean the same as in frames', () => {
    const corpus = fixture('corpus.txt');
    const sizes = [-10, 1, 2, 4, 9, 12].map((level) => z.compressBlockSync(corpus, level).length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThan(sizes[i - 1]!);
    expect(z.compressBlockSync(corpus, 0)).toEqualBytes(z.compressBlockSync(corpus, 1));
    expect(z.compressBlockSync(corpus)).toEqualBytes(z.compressBlockSync(corpus, { level: 1 }));
    // A single-block frame at the same level holds the same compressed bytes.
    for (const level of [-10, 1, 2, 9, 12]) {
      const block = z.compressBlockSync(corpus, level);
      const frame = z.compressSync(corpus, { level, blockSize: 4194304, contentChecksum: false, contentSize: false });
      expect(frame.length).toBe(7 + 4 + block.length + 4); // header, block size, block, end mark
      expect(frame.subarray(11, 11 + block.length)).toEqualBytes(block);
    }
  });

  it('a dictionary changes the block and is required to decompress it', async () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    for (const level of [1, 9]) {
      const plain = z.compressBlockSync(record, level);
      const withDict = z.compressBlockSync(record, { level, dictionary });
      expect(withDict.length).toBeLessThan(plain.length);
      expect(z.decompressBlockSync(withDict, { originalSize: record.length, dictionary })).toEqualBytes(record);
      expect(await z.decompressBlock(withDict, { maxOutputSize: 1000, dictionary })).toEqualBytes(record);
      // Without it the back-references point before the start of the output.
      expect(syncErrorCode(() => z.decompressBlockSync(withDict, record.length))).toBe('ERR_LZ4_LIBRARY');
    }
  });

  it('only the last 64 KiB of a dictionary counts', () => {
    const tail = textBytes(65536, 8);
    const long = new Uint8Array(200_000);
    long.set(randomBytes(200_000 - 65536, 9));
    long.set(tail, 200_000 - 65536);
    const src = textBytes(30_000, 8).subarray(1000);
    const block = z.compressBlockSync(src, { dictionary: long });
    expect(z.compressBlockSync(src, { dictionary: tail })).toEqualBytes(block);
    expect(z.decompressBlockSync(block, { originalSize: src.length, dictionary: tail })).toEqualBytes(src);
  });

  it('validates block options', () => {
    expect(() => z.decompressBlockSync(new Uint8Array(1), undefined as never)).toThrow(TypeError);
    expect(() => z.decompressBlockSync(new Uint8Array(1), {} as never)).toThrow(/exactly one of originalSize/);
    expect(() => z.decompressBlockSync(new Uint8Array(1), { originalSize: 1, maxOutputSize: 2 } as never)).toThrow(/exactly one/);
    expect(() => z.decompressBlockSync(new Uint8Array(1), { maxOutputSize: Infinity })).toThrow(RangeError);
    expect(() => z.decompressBlockSync(new Uint8Array(1), 2_113_929_217)).toThrow(RangeError);
    expect(() => z.decompressBlockSync(new Uint8Array(1), -1)).toThrow(RangeError);
    expect(() => z.decompressBlockSync(new Uint8Array(1), 1.5)).toThrow(RangeError);
    expect(() => z.decompressBlockSync(new Uint8Array(1), { size: 1 } as never)).toThrow(/unknown option "size"/);
    expect(() => z.compressBlockSync('x', { level: 13 })).toThrow(RangeError);
    expect(() => z.compressBlockSync('x', { blockSize: 65536 } as never)).toThrow(/unknown option "blockSize"/);
  });
});

describe('native and wasm blocks agree', () => {
  const [[, native], [, wasm]] = backends;

  it('each decodes the other’s blocks', async () => {
    for (const level of [-5, 1, 2, 9, 12]) {
      const src = textBytes(300_000, level + 60);
      expect(wasm.decompressBlockSync(native.compressBlockSync(src, level), src.length)).toEqualBytes(src);
      expect(native.decompressBlockSync(await wasm.compressBlock(src, level), src.length)).toEqualBytes(src);
    }
  });
});
