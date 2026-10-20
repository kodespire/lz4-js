import { describe, expect, it } from 'vitest';

import { backends, fixture, pipeChunks, syncErrorCode, textBytes } from './helpers.js';

/** Frame header fields, read straight from the bytes. */
function header(frame: Uint8Array) {
  const flg = frame[4]!;
  return {
    blockIndependent: Boolean(flg & 0x20),
    blockChecksum: Boolean(flg & 0x10),
    contentSize: Boolean(flg & 0x08),
    contentChecksum: Boolean(flg & 0x04),
    blockSizeId: (frame[5]! >> 4) & 7,
  };
}

describe.each(backends)('%s backend: options', (_name, z) => {
  const corpus = fixture('corpus.txt');

  // Regression for mongodb-js/zstd NODE-6586, where the level argument was
  // dropped and every call compressed at the default level.
  it('the compression level changes the output', () => {
    const levels = [-100, -10, 1, 2, 4, 9, 12];
    const sizes = levels.map((level) => z.compressSync(corpus, { level }).length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!, `level ${levels[i]}`).toBeLessThan(sizes[i - 1]!);
    // 0, 1 (and the default) are the same fast compressor, as in liblz4 and the CLI.
    expect(z.compressSync(corpus, 0)).toEqualBytes(z.compressSync(corpus, 1));
  });

  it('the level shorthand matches the options form, and the default is level 1', async () => {
    expect(z.compressSync(corpus, 9)).toEqualBytes(z.compressSync(corpus, { level: 9 }));
    expect(await z.compress(corpus, 9)).toEqualBytes(z.compressSync(corpus, { level: 9 }));
    expect(z.compressSync(corpus)).toEqualBytes(z.compressSync(corpus, { level: 1 }));
    expect(z.DEFAULT_LEVEL).toBe(1);
  });

  it('the level reaches streaming compression too', async () => {
    const size = async (level: number) => (await pipeChunks(z.createCompressStream({ level }), corpus)).length;
    expect(await size(12)).toBeLessThan(await size(1));
    expect(await size(1)).toBeLessThan(await size(-20));
  });

  it('contentChecksum adds 4 bytes and is on by default', () => {
    const withSum = z.compressSync(corpus);
    const without = z.compressSync(corpus, { contentChecksum: false });
    expect(withSum.length - without.length).toBe(4);
    expect(header(withSum).contentChecksum).toBe(true);
    expect(header(without).contentChecksum).toBe(false);
    expect(z.compressSync(corpus, { contentChecksum: true })).toEqualBytes(withSum);
  });

  it('blockChecksum adds 4 bytes per block and is off by default', () => {
    const plain = z.compressSync(corpus);
    const checked = z.compressSync(corpus, { blockChecksum: true });
    const blocks = Math.ceil(corpus.length / 65536);
    expect(checked.length - plain.length).toBe(4 * blocks);
    expect(header(plain).blockChecksum).toBe(false);
    expect(header(checked).blockChecksum).toBe(true);
    expect(z.decompressSync(checked)).toEqualBytes(corpus);
  });

  it('blockSize sets the block size in the header and the block layout', () => {
    // Input larger than 4 MiB, so no block size is shrunk to fit it.
    const src = textBytes(5 << 20, 3);
    const frames = ([65536, 262144, 1048576, 4194304] as const).map((blockSize) => z.compressSync(src, { blockSize }));
    expect(frames.map((f) => header(f).blockSizeId)).toEqual([4, 5, 6, 7]);
    expect(new Set(frames.map((f) => f.length)).size).toBe(4);
    for (const frame of frames) expect(z.decompressSync(frame)).toEqualBytes(src);
    expect(z.compressSync(src)).toEqualBytes(frames[0]!); // 64 KiB is the default
    // Input that fits in a smaller block is written with that block size.
    expect(header(z.compressSync(corpus, { blockSize: 4194304 })).blockSizeId).toBe(5);
  });

  it('blocks are linked: a multi-block frame refers back across blocks', () => {
    const frame = z.compressSync(corpus);
    expect(header(frame).blockIndependent).toBe(false);
    // A single block needs no link.
    expect(header(z.compressSync('short')).blockIndependent).toBe(true);
  });

  it('contentSize records the size (8 bytes) and is on by default', () => {
    const sized = z.compressSync(corpus);
    const unsized = z.compressSync(corpus, { contentSize: false });
    expect(sized.length - unsized.length).toBe(8);
    expect(z.getFrameContentSize(sized)).toBe(corpus.length);
    expect(z.getFrameContentSize(unsized)).toBeNull();
    expect(header(sized).contentSize).toBe(true);
    expect(z.decompressSync(unsized)).toEqualBytes(corpus);
  });

  it('stream options reach the frame header', async () => {
    const src = textBytes(300_000, 4);
    const frame = await pipeChunks(z.createCompressStream({ blockChecksum: true, contentChecksum: false, blockSize: 262144 }), src);
    expect(header(frame)).toEqual({ blockIndependent: false, blockChecksum: true, contentSize: false, contentChecksum: false, blockSizeId: 5 });
    expect(z.decompressSync(frame)).toEqualBytes(src);
  });

  it('a dictionary changes the output and is required to decompress', () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const plain = z.compressSync(record);
    const withDict = z.compressSync(record, { dictionary });
    expect(withDict.length).toBeLessThan(plain.length);
    expect(z.decompressSync(withDict, { dictionary })).toEqualBytes(new Uint8Array(record));
    expect(syncErrorCode(() => z.decompressSync(withDict))).toBe('ERR_LZ4_LIBRARY');
    // HC levels use the dictionary too.
    expect(z.compressSync(record, { dictionary, level: 9 }).length).toBeLessThan(z.compressSync(record, 9).length);
  });

  it('accepts every binary input type', () => {
    const src = textBytes(10_000);
    const frame = z.compressSync(src);
    const padded = new Uint8Array(frame.length + 10);
    padded.set(frame, 5);
    const inputs: unknown[] = [
      frame,
      Buffer.from(frame),
      frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength),
      padded.subarray(5, 5 + frame.length),
      new DataView(padded.buffer, 5, frame.length),
    ];
    for (const input of inputs) expect(z.decompressSync(input as Uint8Array)).toEqualBytes(src);
    expect(z.decompressSync(z.compressSync('héllo ✓'))).toEqualBytes(new TextEncoder().encode('héllo ✓'));
    expect(z.decompressBlockSync(z.compressBlockSync('héllo ✓'), 10)).toEqualBytes(new TextEncoder().encode('héllo ✓'));
  });

  it('results are plain Uint8Arrays', async () => {
    for (const out of [z.compressSync('x'), await z.decompress(z.compressSync('x')), z.compressBlockSync('x'), await z.decompressBlock(z.compressBlockSync('x'), 1)]) {
      expect(Object.getPrototypeOf(out)).toBe(Uint8Array.prototype);
    }
  });

  it('rejects unknown option names instead of ignoring them', () => {
    expect(() => z.compressSync('x', { compressionLevel: 9 } as never)).toThrow(/unknown option "compressionLevel".*Did you mean "level"/);
    expect(() => z.compressSync('x', { checksum: false } as never)).toThrow(/Did you mean "contentChecksum"/);
    expect(() => z.decompressSync(z.compressSync('x'), { maxOutput: 10 } as never)).toThrow(/unknown option "maxOutput"/);
    expect(() => z.createCompressStream({ contentSize: true } as never)).toThrow(/stream does not know the total size/);
  });

  it('validates option values', () => {
    expect(() => z.compressSync('x', { level: 13 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: -65537 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: 1.5 })).toThrow(RangeError);
    expect(() => z.compressSync('x', { level: '3' as never })).toThrow(RangeError);
    expect(() => z.compressSync('x', { blockSize: 100_000 as never })).toThrow(RangeError);
    expect(() => z.compressSync('x', { contentChecksum: 1 as never })).toThrow(TypeError);
    expect(() => z.compressSync('x', { blockChecksum: 'yes' as never })).toThrow(TypeError);
    expect(() => z.compressSync('x', { contentSize: null as never })).toThrow(TypeError);
    expect(() => z.compressSync('x', { level: null as never })).toThrow(RangeError);
    expect(() => z.decompressSync(new Uint8Array(1), { maxOutputSize: null as never })).toThrow(RangeError);
    expect(() => z.decompressSync(new Uint8Array(1), { maxOutputSize: -1 })).toThrow(RangeError);
    expect(() => z.decompressSync(new Uint8Array(1), { maxOutputSize: 1.5 })).toThrow(RangeError);
    expect(() => z.decompressSync('abc' as never)).toThrow(TypeError);
    expect(() => z.compressSync(123 as never)).toThrow(TypeError);
    expect(() => z.compressSync('x', null as never)).toThrow(TypeError);
  });

  it('accepts the extreme levels', () => {
    for (const level of [z.MIN_LEVEL, -1, 0, z.HC_MIN_LEVEL, z.MAX_LEVEL]) {
      expect(z.decompressSync(z.compressSync(corpus, { level }))).toEqualBytes(corpus);
      expect(z.decompressBlockSync(z.compressBlockSync(corpus, { level }), corpus.length)).toEqualBytes(corpus);
    }
  });

  it('getFrameContentSize and isLz4Frame', () => {
    expect(z.getFrameContentSize(fixture('corpus.size.lz4'))).toBe(corpus.length);
    expect(z.getFrameContentSize(fixture('corpus.stdin.lz4'))).toBeNull();
    expect(z.getFrameContentSize(new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]))).toBe(0); // skippable
    expect(() => z.getFrameContentSize(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/not an LZ4 frame/);
    expect(() => z.getFrameContentSize(fixture('corpus.size.lz4').subarray(0, 10))).toThrow(/not an LZ4 frame/);
    const badHeader = new Uint8Array(fixture('corpus.size.lz4').subarray(0, 20));
    badHeader[14]! ^= 1;
    expect(() => z.getFrameContentSize(badHeader)).toThrow(/header checksum/);
    expect(z.isLz4Frame(fixture('corpus.stdin.lz4'))).toBe(true);
    expect(z.isLz4Frame(new Uint8Array([0x5f, 0x2a, 0x4d, 0x18]))).toBe(true); // skippable
    expect(z.isLz4Frame(fixture('corpus.legacy.lz4'))).toBe(false);
    expect(z.isLz4Frame(corpus)).toBe(false);
    expect(z.isLz4Frame(new Uint8Array(2))).toBe(false);
  });
});
