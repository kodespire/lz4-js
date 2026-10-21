// Self-test of @kodespire/lz4-js on a device or simulator. Each result is logged as
// one `LZ4_SELFTEST ...` line, which scripts/selftest.mjs reads from the device log,
// and the last line is `LZ4_SELFTEST DONE passed=N failed=M`.
import {
  activeBackend,
  compress,
  compressBlock,
  compressBlockSync,
  compressSync,
  createCompressStream,
  createDecompressStream,
  decompress,
  decompressBlock,
  decompressBlockSync,
  decompressSync,
  getFrameContentSize,
  init,
  isLz4Frame,
  LZ4_VERSION,
  Lz4Error,
  type CompressOptions,
} from '@kodespire/lz4-js';

// @ts-ignore generated plain JS
import fixtureData from './fixtures.generated';

declare const require: (id: string) => unknown;

type Log = (line: string) => void;

function fixture(name: string): Uint8Array {
  const binary = atob((fixtureData as Record<string, string>)[name]!);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Deterministic, moderately compressible bytes (the same generator as test/helpers.ts). */
function textBytes(length: number, seed = 1): Uint8Array {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'lz4 ', 'frame ', 'block ', '\n'];
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  let i = 0;
  while (i < length) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const w = words[(x & 0xff) % words.length]!;
    for (let j = 0; j < w.length && i < length; j++) out[i++] = w.charCodeAt(j);
  }
  return out;
}

/** The raw blocks inside a legacy-format (`lz4 -l`) file: magic, then [u32 size, block]*. */
function legacyBlocks(data: Uint8Array): Uint8Array[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert(view.getUint32(0, true) === 0x184c2102, 'not a legacy lz4 file');
  const blocks: Uint8Array[] = [];
  for (let pos = 4; pos < data.length;) {
    const size = view.getUint32(pos, true);
    blocks.push(data.subarray(pos + 4, pos + 4 + size));
    pos += 4 + size;
  }
  return blocks;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert(actual instanceof Uint8Array, `${what}: not a Uint8Array`);
  assert(actual.length === expected.length, `${what}: length ${actual.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${what}: differs at byte ${i}`);
  }
}

/** `code` is the expected error code, or a list of acceptable ones. */
async function assertCode(run: () => unknown, code: string | string[], what: string): Promise<void> {
  const codes = typeof code === 'string' ? [code] : code;
  try {
    await run();
  } catch (error) {
    assert(error instanceof Lz4Error, `${what}: threw ${String(error)}, expected an Lz4Error`);
    assert(codes.includes(error.code), `${what}: code ${error.code}, expected ${codes.join(' or ')}`);
    return;
  }
  throw new Error(`${what}: did not throw ${codes.join(' or ')}`);
}

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, chunks: Uint8Array[]): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parts.push(value);
    }
  })();
  const writing = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })();
  await Promise.all([reading, writing]);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function split(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
  return chunks;
}

const tests: [name: string, run: (log: Log) => Promise<void>][] = [
  ['native backend', async (log) => {
    await init();
    assert(activeBackend() === 'native', `activeBackend() is ${activeBackend()}`);
    log(`info lz4 ${LZ4_VERSION}`);
  }],

  ['round trip', async () => {
    const data = textBytes(1 << 20);
    const optionSets: (CompressOptions | number | undefined)[] = [
      undefined,
      1,
      { level: 12 },
      { level: -5, contentChecksum: false, blockChecksum: true },
      { level: 9, blockSize: 4194304, contentSize: false },
    ];
    for (const options of optionSets) {
      const packed = await compress(data, options);
      assert(isLz4Frame(packed), 'output is not an LZ4 frame');
      const size = typeof options === 'object' && options.contentSize === false ? null : data.length;
      assert(getFrameContentSize(packed) === size, `frame content size ${getFrameContentSize(packed)}, expected ${size}`);
      assertBytes(await decompress(packed), data, `async, options ${JSON.stringify(options)}`);
      assertBytes(decompressSync(compressSync(data, options)), data, `sync, options ${JSON.stringify(options)}`);
    }
    const text = 'héllo € 😀 '.repeat(100);
    assertBytes(decompressSync(compressSync(text)), new TextEncoder().encode(text), 'string input');
    const empty = await compress(new Uint8Array(0));
    assert(getFrameContentSize(empty) === null, 'an empty frame cannot record its size');
    assertBytes(await decompress(empty), new Uint8Array(0), 'empty input');
    // A view into a larger buffer: only the viewed bytes are compressed.
    const view = new Uint8Array(data.buffer, 1000, 5000);
    assertBytes(await decompress(await compress(view)), data.subarray(1000, 6000), 'subarray input');
  }],

  ['frames from the lz4 CLI', async () => {
    const corpus = fixture('corpus.txt');
    assertBytes(await decompress(fixture('corpus.hc12.lz4')), corpus, 'corpus.hc12.lz4');
    assertBytes(decompressSync(fixture('corpus.multi.lz4')), corpus, 'corpus.multi.lz4 (concatenated frames)');
  }],

  ['truncated input', async () => {
    const packed = compressSync(textBytes(100_000));
    for (const end of [1, 4, packed.length >> 1, packed.length - 1]) {
      const cut = packed.subarray(0, end);
      await assertCode(() => decompress(cut), 'ERR_LZ4_TRUNCATED', `decompress, ${end} bytes`);
      await assertCode(() => decompressSync(cut), 'ERR_LZ4_TRUNCATED', `decompressSync, ${end} bytes`);
    }
    await assertCode(() => decompress(new Uint8Array(0)), 'ERR_LZ4_TRUNCATED', 'empty input');
    const corrupt = packed.slice();
    corrupt[corrupt.length >> 1] ^= 0xff;
    await assertCode(() => decompress(corrupt), 'ERR_LZ4_LIBRARY', 'corrupt input');
  }],

  ['maxOutputSize', async () => {
    const data = textBytes(200_000);
    const packed = await compress(data);
    await assertCode(() => decompress(packed, { maxOutputSize: data.length - 1 }), 'ERR_LZ4_OUTPUT_LIMIT', 'async, one byte short');
    await assertCode(() => decompressSync(packed, { maxOutputSize: 0 }), 'ERR_LZ4_OUTPUT_LIMIT', 'sync, limit 0');
    assertBytes(await decompress(packed, { maxOutputSize: data.length }), data, 'exact limit');
    await assertCode(() => decompress(new Uint8Array(0), { maxOutputSize: 10 }), 'ERR_LZ4_TRUNCATED', 'empty input with a limit');
  }],

  ['raw blocks', async () => {
    const data = textBytes(300_000, 7);
    for (const level of [-5, 1, 9, 12]) {
      const block = await compressBlock(data, level);
      assert(!isLz4Frame(block), `level ${level}: a block looks like a frame`);
      assertBytes(await decompressBlock(block, data.length), data, `async, level ${level}`);
      assertBytes(decompressBlockSync(compressBlockSync(data, { level }), { originalSize: data.length }), data, `sync, level ${level}`);
    }
    // originalSize must be exact; maxOutputSize is an upper bound.
    const block = compressBlockSync(data);
    await assertCode(() => decompressBlock(block, data.length + 1), 'ERR_LZ4_TRUNCATED', 'originalSize one too big');
    await assertCode(() => decompressBlockSync(block, data.length - 1), 'ERR_LZ4_OUTPUT_LIMIT', 'originalSize one too small');
    assertBytes(await decompressBlock(block, { maxOutputSize: data.length + 1000 }), data, 'maxOutputSize above the size');
    await assertCode(() => decompressBlock(block, { maxOutputSize: data.length - 1 }), 'ERR_LZ4_OUTPUT_LIMIT', 'maxOutputSize one short');
    await assertCode(() => decompressBlockSync(block.subarray(0, block.length >> 1), data.length),
      ['ERR_LZ4_LIBRARY', 'ERR_LZ4_TRUNCATED'], 'half a block with originalSize');
    // The empty input is a one-byte block; zero bytes are not a block.
    assertBytes(compressBlockSync(new Uint8Array(0)), new Uint8Array([0]), 'empty block');
    assertBytes(decompressBlockSync(new Uint8Array([0]), 0), new Uint8Array(0), 'empty block decoded');
    await assertCode(() => decompressBlock(new Uint8Array(0), 0), 'ERR_LZ4_TRUNCATED', 'zero bytes');
    // A block written by the lz4 CLI: the one raw block inside a legacy-format file.
    const corpus = fixture('corpus.txt');
    const [cliBlock, ...rest] = legacyBlocks(fixture('corpus.legacy.lz4'));
    assert(cliBlock && rest.length === 0, 'corpus.legacy.lz4 should hold one block');
    assertBytes(await decompressBlock(cliBlock, corpus.length), corpus, 'block from the lz4 CLI');
    // A dictionary is required to decompress a block made with it.
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const withDict = await compressBlock(record, { dictionary, level: 9 });
    assert(withDict.length < compressBlockSync(record, 9).length, 'dictionary did not shrink the block');
    assertBytes(decompressBlockSync(withDict, { originalSize: record.length, dictionary }), record, 'dictionary block');
    assertBytes(await decompressBlock(withDict, { maxOutputSize: 1000, dictionary }), record, 'dictionary block, maxOutputSize');
    await assertCode(() => decompressBlockSync(withDict, record.length), 'ERR_LZ4_LIBRARY', 'dictionary block without the dictionary');
  }],

  ['async work runs off the JS thread', async (log) => {
    // Grow the input until one async compress takes long enough to measure, then
    // check the JS thread kept running timers the whole time. Level 12 is LZ4 HC's
    // slowest: the fast compressor may finish too quickly to measure.
    let size = 4 << 20;
    for (;;) {
      const data = textBytes(size);
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 10);
      const start = performance.now();
      const packed = await compress(data, 12);
      const elapsed = performance.now() - start;
      clearInterval(timer);
      if (elapsed < 400 && size < 64 << 20) {
        size *= 2;
        continue;
      }
      assertBytes(decompressSync(packed), data, 'output');
      log(`info compress(${size >> 20} MiB, 12): ${elapsed.toFixed(0)} ms, ${ticks} timer ticks, longest JS stall ${maxGap.toFixed(0)} ms`);
      assert(ticks >= 10, `only ${ticks} timer ticks in ${elapsed.toFixed(0)} ms`);
      assert(maxGap < elapsed / 2, `JS thread stalled for ${maxGap.toFixed(0)} ms of ${elapsed.toFixed(0)} ms`);
      break;
    }
    // Several jobs at once, and inputs captured at call time.
    const inputs = [1, 2, 3, 4].map((seed) => textBytes(500_000, seed));
    const expected = inputs.map((input) => input.slice());
    const pending = inputs.map((input) => compress(input, 9));
    const pendingBlock = compressBlock(inputs[0]!, 9);
    for (const input of inputs) input.fill(0);
    const outputs = await Promise.all(pending);
    for (let i = 0; i < outputs.length; i++) assertBytes(decompressSync(outputs[i]!), expected[i]!, `job ${i}`);
    assertBytes(decompressBlockSync(await pendingBlock, expected[0]!.length), expected[0]!, 'block job');
  }],

  ['dictionary', async () => {
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    assertBytes(await decompress(fixture('record.dict.lz4'), { dictionary }), record, 'frame from the lz4 CLI');
    const packed = await compress(record, { dictionary, level: 9 });
    assertBytes(decompressSync(packed, { dictionary }), record, 'round trip');
    assert(packed.length < compressSync(record, 9).length, 'dictionary did not shrink the output');
    await assertCode(() => decompress(packed), 'ERR_LZ4_LIBRARY', 'without the dictionary');
    // Any bytes work as a dictionary.
    const raw = textBytes(20_000, 9);
    const rawPacked = compressSync(textBytes(1000, 9), { dictionary: raw });
    assertBytes(await decompress(rawPacked, { dictionary: raw }), textBytes(1000, 9), 'raw dictionary');
  }],

  ['options are checked', async () => {
    let threw = false;
    try {
      compressSync(new Uint8Array(1), { compressionLevel: 3 } as never);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, 'an unknown option did not throw a TypeError');
    threw = false;
    try {
      decompressBlockSync(new Uint8Array(1), {} as never);
    } catch (error) {
      threw = error instanceof TypeError;
    }
    assert(threw, 'a block without originalSize or maxOutputSize did not throw a TypeError');
  }],

  ['streams', async (log) => {
    if (typeof TransformStream === 'undefined') {
      let message = '';
      try {
        createCompressStream();
      } catch (error) {
        message = String(error);
      }
      assert(/TransformStream/.test(message), `without a TransformStream: ${message || 'no error'}`);
      require('web-streams-polyfill/polyfill');
      log('info no global TransformStream: using web-streams-polyfill');
    }
    const data = textBytes(1 << 20, 5);
    const packed = await pipe(createCompressStream({ level: 5, blockChecksum: true }), split(data, 65_536));
    assertBytes(decompressSync(packed), data, 'compress stream');
    assertBytes(await pipe(createDecompressStream(), split(packed, 7_000)), data, 'decompress stream');
    const dictionary = fixture('dict.bin');
    const record = fixture('record.json');
    const dictPacked = await pipe(createCompressStream({ dictionary }), [record]);
    assertBytes(decompressSync(dictPacked, { dictionary }), record, 'dictionary stream');
    await assertCode(() => pipe(createDecompressStream(), [packed.subarray(0, packed.length - 3)]), 'ERR_LZ4_TRUNCATED', 'truncated stream');
    await assertCode(() => pipe(createDecompressStream({ maxOutputSize: 1000 }), [packed]), 'ERR_LZ4_OUTPUT_LIMIT', 'stream over maxOutputSize');
  }],

  ['speed', async (log) => {
    const data = textBytes(8 << 20);
    let start = performance.now();
    const packed = compressSync(data);
    const compressMs = performance.now() - start;
    start = performance.now();
    decompressSync(packed);
    const decompressMs = performance.now() - start;
    const mbps = (ms: number) => (data.length / 1e6 / (ms / 1000)).toFixed(0);
    log(`info level 1, 8 MiB: compress ${mbps(compressMs)} MB/s, decompress ${mbps(decompressMs)} MB/s, ratio ${(data.length / packed.length).toFixed(2)}`);
  }],
];

export async function runSelfTest(log: Log): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  for (const [name, run] of tests) {
    const start = performance.now();
    try {
      await run(log);
      passed++;
      log(`ok ${name} (${(performance.now() - start).toFixed(0)} ms)`);
    } catch (error) {
      failed++;
      log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`DONE passed=${passed} failed=${failed}`);
  return failed === 0;
}
