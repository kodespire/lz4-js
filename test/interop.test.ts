// Interoperability with the official lz4 CLI, built from the same deps/lz4.
// Fixtures in test/fixtures were produced by it (scripts/make-fixtures.mjs);
// the CLI round-trip tests run when out/lz4-cli exists (or LZ4_CLI is set).
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { backends, concat, fixture, fixturePath, legacyBlocks, legacyFile, lz4Cli, pipeChunks, syncErrorCode, textBytes } from './helpers.js';

const corpus = new Uint8Array(fixture('corpus.txt'));

describe.each(backends)('%s backend: decodes official CLI output', (_name, z) => {
  it.each([
    'corpus.stdin.lz4',
    'corpus.size.lz4',
    'corpus.hc9.lz4',
    'corpus.hc12.lz4',
    'corpus.fast5.lz4',
    'corpus.nocheck.lz4',
    'corpus.blockcheck.lz4',
    'corpus.b4linked.lz4',
    'corpus.b5.lz4',
    'corpus.favor.lz4',
    'corpus.multi.lz4',
  ])('%s', async (name) => {
    expect(z.decompressSync(fixture(name))).toEqualBytes(corpus);
    expect(await z.decompress(fixture(name))).toEqualBytes(corpus);
    expect(await pipeChunks(z.createDecompressStream(), fixture(name), () => 4099)).toEqualBytes(corpus);
  });

  it('dictionary frame', () => {
    expect(z.decompressSync(fixture('record.dict.lz4'), { dictionary: fixture('dict.bin') })).toEqualBytes(fixture('record.json'));
  });

  it('empty frame', () => {
    expect(z.decompressSync(fixture('empty-frame.lz4'))).toEqualBytes(new Uint8Array(0));
  });

  it('raw blocks from a legacy-format file (lz4 -l)', () => {
    const [block, ...rest] = legacyBlocks(fixture('corpus.legacy.lz4'));
    expect(rest).toHaveLength(0); // the corpus fits in one 8 MiB legacy chunk
    expect(z.decompressBlockSync(block!, corpus.length)).toEqualBytes(corpus);
    expect(z.decompressBlockSync(block!, { maxOutputSize: 8 << 20 })).toEqualBytes(corpus);
  });

  it('the legacy format itself is not a frame and is rejected', () => {
    expect(syncErrorCode(() => z.decompressSync(fixture('corpus.legacy.lz4')))).toBe('ERR_LZ4_LIBRARY');
  });
});

describe.skipIf(!lz4Cli).each(backends)('%s backend: official CLI decodes our output', (_name, z) => {
  const cli = (args: string[], input: Uint8Array) =>
    new Uint8Array(execFileSync(lz4Cli!, ['-q', '-c', ...args], { input, maxBuffer: 1 << 30 }));
  const cliDecompress = (data: Uint8Array, args: string[] = []) => cli(['-d', ...args], data);

  it.each([-20, 1, 2, 9, 12])('level %i', (level) => {
    const src = textBytes(500_000, level + 100);
    expect(cliDecompress(z.compressSync(src, { level }))).toEqualBytes(src);
  });

  it.each([
    { blockSize: 65536 },
    { blockSize: 262144, blockChecksum: true },
    { blockSize: 1048576, contentChecksum: false },
    { blockSize: 4194304, contentSize: false },
  ] as const)('options %o', (options) => {
    const src = textBytes(6 << 20, 7);
    expect(cliDecompress(z.compressSync(src, options))).toEqualBytes(src);
  });

  it('streamed frames, and concatenated frames', async () => {
    const src = textBytes(800_000, 5);
    const streamed = await pipeChunks(z.createCompressStream({ level: 9 }), src, () => 77_777);
    expect(cliDecompress(streamed)).toEqualBytes(src);
    expect(cliDecompress(concat(streamed, z.compressSync(src)))).toEqualBytes(concat(src, src));
  });

  it('dictionary', () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    for (const level of [1, 9]) {
      expect(cliDecompress(z.compressSync(record, { dictionary, level }), ['-D', fixturePath('dict.bin')])).toEqualBytes(record);
    }
  });

  it('raw blocks, wrapped in a legacy-format file', () => {
    // The CLI only reads blocks inside the legacy format, where each decodes to at most 8 MiB.
    const parts = [textBytes(8 << 20, 1), textBytes(1_000_000, 2), new TextEncoder().encode('end')];
    const file = legacyFile(...parts.map((p, i) => z.compressBlockSync(p, i === 1 ? 9 : 1)));
    expect(cliDecompress(file)).toEqualBytes(concat(...parts));
  });

  it('we decode large multi-block CLI frames', () => {
    const src = textBytes(9 << 20, 8);
    for (const args of [[], ['-BD'], ['-B4', '-BX', '--content-size'], ['-9', '-B6']]) {
      // From stdin, so --content-size has nothing to record; it must still decode.
      expect(z.decompressSync(cli(args, src)), args.join(' ')).toEqualBytes(src);
    }
  });
});
