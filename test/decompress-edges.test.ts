// The decompression loop is where LZ4 bindings usually go wrong: output that
// fills a buffer exactly, frames without a recorded size, concatenated and
// skippable frames, and input that ends mid-frame. Every case runs on both backends.
import { describe, expect, it } from 'vitest';

import { backends, concat, errorCode, pipeChunks, randomBytes, skippableFrame, syncErrorCode, textBytes } from './helpers.js';

// Sizes around the 64 KiB default block size, the binding's 64 KiB initial
// allocation and its 1.5x growth steps, and the larger block sizes.
const BOUNDARY_SIZES = [
  0, 1, 2, 65535, 65536, 65537, 98303, 98304, 98305, 131071, 131072, 131073,
  147456, 196607, 196608, 196609, 262143, 262144, 262145, 1 << 20, (1 << 20) + 1,
  (4 << 20) - 1, 4 << 20, (4 << 20) + 1,
];

const BLOCK_SIZES = [65536, 262144, 1048576, 4194304] as const;

describe.each(backends)('%s backend: decompression edge cases', (name, z) => {
  it('reports the expected backend', () => {
    expect(z.activeBackend()).toBe(name);
  });

  it.each(BOUNDARY_SIZES)('frame with recorded size, %i bytes', async (size) => {
    const src = textBytes(size, size + 1);
    const frame = z.compressSync(src);
    // The format reads a recorded size of 0 as "unknown".
    expect(z.getFrameContentSize(frame)).toBe(size === 0 ? null : size);
    expect(z.decompressSync(frame)).toEqualBytes(src);
    expect(await z.decompress(frame)).toEqualBytes(src);
    // A limit equal to the exact size must pass; one byte less must not.
    expect(z.decompressSync(frame, { maxOutputSize: size })).toEqualBytes(src);
    if (size > 0) expect(syncErrorCode(() => z.decompressSync(frame, { maxOutputSize: size - 1 }))).toBe('ERR_LZ4_OUTPUT_LIMIT');
  });

  it.each(BOUNDARY_SIZES)('streamed frame without recorded size, %i bytes', async (size) => {
    const src = randomBytes(size, size + 7).map((b, i) => (i % 3 === 0 ? b : 0x61)); // partly compressible
    // A compress stream never knows the total size, so the header omits it.
    const frame = await pipeChunks(z.createCompressStream({ contentChecksum: false }), src, () => 50_000);
    expect(z.getFrameContentSize(frame)).toBeNull();
    expect(z.decompressSync(frame)).toEqualBytes(src);
    expect(await z.decompress(frame, { maxOutputSize: size })).toEqualBytes(src);
  });

  it.each(BLOCK_SIZES)('every block size, around its boundaries (%i)', (blockSize) => {
    for (const size of [blockSize - 1, blockSize, blockSize + 1, 2 * blockSize + 1]) {
      const src = textBytes(size, blockSize + size);
      for (const linked of [z.compressSync(src, { blockSize }), z.compressSync(src, { blockSize, contentSize: false, blockChecksum: true })]) {
        expect(z.decompressSync(linked), `${size} bytes`).toEqualBytes(src);
      }
    }
  });

  it('highly compressible input: 64 MiB of zeros', async () => {
    const src = new Uint8Array(64 << 20);
    const frame = await z.compress(src, 1);
    // LZ4 tops out near 255:1.
    expect(frame.length).toBeLessThan(300_000);
    const out = await z.decompress(frame);
    expect(out.length).toBe(src.length);
    expect(out.every((b) => b === 0)).toBe(true);
  });

  it('concatenated frames decode to the concatenated input', () => {
    const a = textBytes(100_000, 1);
    const b = randomBytes(70_000, 2);
    const c = new Uint8Array(0);
    const joined = concat(z.compressSync(a), z.compressSync(b, { contentChecksum: false }), z.compressSync(c), z.compressSync(a, 9));
    expect(z.decompressSync(joined)).toEqualBytes(concat(a, b, c, a));
  });

  it('skippable frames are skipped wherever they appear', () => {
    const a = textBytes(5000, 3);
    const b = textBytes(7000, 4);
    const skip = skippableFrame(new TextEncoder().encode('metadata'), 0);
    const skipEmpty = skippableFrame(new Uint8Array(0), 15);
    const data = concat(skip, z.compressSync(a), skipEmpty, z.compressSync(b), skip);
    expect(z.decompressSync(data)).toEqualBytes(concat(a, b));
  });

  it('input consisting only of a skippable frame decodes to nothing', () => {
    expect(z.decompressSync(skippableFrame(new Uint8Array([1, 2, 3])))).toEqualBytes(new Uint8Array(0));
  });

  it('a valid frame holding zero bytes decodes to nothing', () => {
    const frame = z.compressSync(new Uint8Array(0));
    expect(frame.length).toBe(15); // 7-byte header, 4-byte end mark, 4-byte content checksum
    expect(z.decompressSync(frame)).toEqualBytes(new Uint8Array(0));
  });
});

describe.each(backends)('%s backend: truncated and invalid input', (_name, z) => {
  it('empty input is an error, as with the lz4 CLI', async () => {
    expect(syncErrorCode(() => z.decompressSync(new Uint8Array(0)))).toBe('ERR_LZ4_TRUNCATED');
    expect(await errorCode(() => z.decompress(new Uint8Array(0)))).toBe('ERR_LZ4_TRUNCATED');
  });

  it('every proper prefix of a frame is rejected as truncated, for every frame option', () => {
    const src = textBytes(3000, 9);
    const variants = [
      {},
      { contentChecksum: false },
      { contentChecksum: false, contentSize: false },
      { blockChecksum: true },
      { level: 9, contentSize: false },
    ];
    for (const options of variants) {
      const frame = z.compressSync(src, options);
      for (let cut = 0; cut < frame.length; cut++) {
        const code = syncErrorCode(() => z.decompressSync(frame.subarray(0, cut)));
        expect(code, `cut at ${cut}/${frame.length}, ${JSON.stringify(options)}`).toBe('ERR_LZ4_TRUNCATED');
      }
      expect(z.decompressSync(frame)).toEqualBytes(src);
    }
  });

  it('every proper prefix of a multi-block linked frame is rejected (no checksum, no size)', () => {
    // Without the content checksum or size, only the end mark tells a complete frame
    // from one cut at a block boundary.
    // Three 64 KiB blocks that compress well, so trying every cut stays fast.
    const period = randomBytes(1000, 12);
    const src = new Uint8Array(150_000).map((_, i) => period[i % 1000]! ^ (i % 7919 === 0 ? 1 : 0));
    const frame = z.compressSync(src, { contentChecksum: false, contentSize: false });
    expect(frame.length).toBeLessThan(5000);
    for (let cut = 0; cut < frame.length; cut++) {
      if (syncErrorCode(() => z.decompressSync(frame.subarray(0, cut))) !== 'ERR_LZ4_TRUNCATED') {
        expect.fail(`cut at ${cut}/${frame.length} was not rejected`);
      }
    }
  });

  it('truncating a large frame is rejected (sampled offsets)', async () => {
    const src = textBytes(3 << 20, 10);
    const frame = await z.compress(src, { blockSize: 1048576 });
    for (const cut of [1, 4, 5, 6, 7, 13, frame.length >> 2, frame.length >> 1, frame.length - 5, frame.length - 4, frame.length - 1]) {
      expect(await errorCode(() => z.decompress(frame.subarray(0, cut))), `cut at ${cut}`).toBe('ERR_LZ4_TRUNCATED');
    }
  });

  it('regression: 1 MB of zeros with the last 3 bytes cut is an error, not partial output', async () => {
    const frame = await z.compress(new Uint8Array(1_000_000), { contentChecksum: false, contentSize: false });
    expect(await errorCode(() => z.decompress(frame.subarray(0, frame.length - 3)))).toBe('ERR_LZ4_TRUNCATED');
  });

  it('a second frame cut short is rejected even though the first is complete', () => {
    const data = concat(z.compressSync(textBytes(1000, 1)), z.compressSync(textBytes(1000, 2)));
    expect(syncErrorCode(() => z.decompressSync(data.subarray(0, data.length - 1)))).toBe('ERR_LZ4_TRUNCATED');
  });

  it('a skippable frame cut short is rejected', () => {
    const data = skippableFrame(new Uint8Array(100));
    for (const cut of [1, 4, 7, 8, 50, 107]) {
      expect(syncErrorCode(() => z.decompressSync(data.subarray(0, cut))), `cut at ${cut}`).toBe('ERR_LZ4_TRUNCATED');
    }
  });

  it('corrupted data is rejected when the frame has a content checksum', () => {
    const src = textBytes(200_000, 11);
    const frame = z.compressSync(src);
    let rejected = 0;
    for (let i = 0; i < frame.length; i += Math.max(1, Math.floor(frame.length / 60))) {
      const bad = frame.slice();
      bad[i]! ^= 0x5a;
      const code = syncErrorCode(() => z.decompressSync(bad));
      expect(code, `flip at ${i}`).not.toBe('no error');
      rejected++;
    }
    expect(rejected).toBeGreaterThan(30);
  });

  it('the header checksum catches a corrupt header even without content checksums', () => {
    const frame = z.compressSync(textBytes(10_000, 5), { contentChecksum: false });
    for (let i = 4; i < 15; i++) {
      const bad = frame.slice();
      bad[i]! ^= 0x01;
      expect(syncErrorCode(() => z.decompressSync(bad)), `flip at ${i}`).toBe('ERR_LZ4_LIBRARY');
    }
  });

  it('block checksums catch a corrupt block', () => {
    const frame = z.compressSync(textBytes(100_000, 6), { contentChecksum: false, blockChecksum: true });
    const bad = frame.slice();
    bad[40]! ^= 0x10;
    expect(() => z.decompressSync(bad)).toThrow(/block checksum mismatch/);
  });

  it('trailing garbage after a frame is rejected', () => {
    const frame = z.compressSync(textBytes(1000, 1));
    expect(syncErrorCode(() => z.decompressSync(concat(frame, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))))).toBe('ERR_LZ4_LIBRARY');
  });

  it('data that is not LZ4 is rejected', () => {
    expect(() => z.decompressSync(new TextEncoder().encode('definitely not lz4'))).toThrow(
      expect.objectContaining({ code: 'ERR_LZ4_LIBRARY', message: 'lz4: not LZ4 frame data (unknown magic number)' }),
    );
  });

  it('a header whose content size disagrees with the data is rejected', () => {
    const frame = z.compressSync(textBytes(1000, 2), { contentChecksum: false });
    // Rewrite the recorded size (bytes 6..13) and the header checksum (byte 14)
    // by building the same header with another size.
    const other = z.compressSync(textBytes(999, 2), { contentChecksum: false });
    const forged = concat(other.subarray(0, 15), frame.subarray(15));
    expect(() => z.decompressSync(forged)).toThrow(/content size/);
  });

  it('maxOutputSize stops a decompression bomb early', async () => {
    // 256 MiB of zeros, compressed by streaming 16 MiB chunks.
    const zeros = new Uint8Array(16 << 20);
    const parts: Uint8Array[] = [];
    const stream = z.createCompressStream({ blockSize: 4194304 });
    const writer = stream.writable.getWriter();
    const reading = (async () => {
      for await (const p of stream.readable as unknown as AsyncIterable<Uint8Array>) parts.push(p);
    })();
    for (let i = 0; i < 16; i++) await writer.write(zeros);
    await writer.close();
    await reading;
    const bomb = concat(...parts);
    expect(bomb.length).toBeLessThan(1_200_000);

    // "Early" means it stops near the limit, not after decoding everything: hitting
    // a 1 MiB limit must take a small fraction of the time a full decode takes.
    let started = performance.now();
    expect((await z.decompress(bomb)).length).toBe(256 << 20);
    const full = performance.now() - started;
    started = performance.now();
    expect(await errorCode(() => z.decompress(bomb, { maxOutputSize: 1 << 20 }))).toBe('ERR_LZ4_OUTPUT_LIMIT');
    const limited = performance.now() - started;
    expect(limited, `limited ${limited.toFixed(1)} ms vs full ${full.toFixed(1)} ms`).toBeLessThan(full / 4);
  });

  it('maxOutputSize: 0 accepts only empty output', () => {
    expect(z.decompressSync(z.compressSync(new Uint8Array(0)), { maxOutputSize: 0 })).toEqualBytes(new Uint8Array(0));
    expect(syncErrorCode(() => z.decompressSync(z.compressSync('x'), { maxOutputSize: 0 }))).toBe('ERR_LZ4_OUTPUT_LIMIT');
  });
});
