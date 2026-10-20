// Regenerates test/fixtures with the official lz4 CLI built from deps/lz4.
// The fixtures are committed; rerun this only when changing them.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCli } from './build-lz4-cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures');
const lz4 = buildCli();

// Deterministic, compressible text.
function corpus(seed, words) {
  const vocab = 'the quick brown fox jumps over lazy dog lz4 frame block literal match offset token sequence hash chain window stream buffer chunk'.split(' ');
  let x = seed >>> 0;
  const parts = [];
  for (let i = 0; i < words; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    parts.push(vocab[x % vocab.length]);
    if (x % 17 === 0) parts.push(`${x % 100000}\n`);
  }
  return Buffer.from(parts.join(' '));
}

const run = (args, input) => execFileSync(lz4, args, { input, maxBuffer: 1 << 30 });
const write = (name, data) => writeFileSync(join(out, name), data);

const text = corpus(1, 30000);
write('corpus.txt', text);
// Defaults from stdin: 4 MiB independent blocks, content checksum, no content size.
write('corpus.stdin.lz4', run(['-q', '-c'], text));
write('corpus.hc9.lz4', run(['-q', '-c', '-9'], text));
write('corpus.hc12.lz4', run(['-q', '-c', '-12'], text));
write('corpus.fast5.lz4', run(['-q', '-c', '--fast=5'], text));
write('corpus.nocheck.lz4', run(['-q', '-c', '--no-frame-crc'], text));
write('corpus.blockcheck.lz4', run(['-q', '-c', '-BX'], text));
// 64 KiB linked blocks: many blocks, each referring back into the previous ones.
write('corpus.b4linked.lz4', run(['-q', '-c', '-B4', '-BD'], text));
write('corpus.b5.lz4', run(['-q', '-c', '-B5'], text));
write('corpus.favor.lz4', run(['-q', '-c', '-12', '--favor-decSpeed'], text));
// Two frames back to back, as `cat a.lz4 b.lz4` produces.
const half = text.length >> 1;
write('corpus.multi.lz4', Buffer.concat([run(['-q', '-c'], text.subarray(0, half)), run(['-q', '-c', '-9'], text.subarray(half))]));
// Legacy format (lz4 -l, used by the Linux kernel): not a frame, but each
// 8 MiB chunk inside is a raw block, which tests decompressBlock against the CLI.
write('corpus.legacy.lz4', run(['-q', '-c', '-l'], text));

const tmp = mkdtempSync(join(tmpdir(), 'lz4-js-fixtures-'));
try {
  // From a file with --content-size: the header records the size.
  const file = join(tmp, 'corpus.txt');
  writeFileSync(file, text);
  write('corpus.size.lz4', run(['-q', '-c', '--content-size', file]));

  // Dictionary: LZ4 takes any bytes as a dictionary (only the last 64 KiB
  // count). Use JSON records like the one being compressed.
  const record = (i) => JSON.stringify({ id: i, user: `user-${i % 37}`, status: ['active', 'idle', 'banned'][i % 3], score: (i * 7919) % 1000, tags: ['alpha', 'beta', String(i % 11)] });
  const dict = Buffer.from(Array.from({ length: 400 }, (_, i) => record(i)).join('\n'));
  const dictFile = join(tmp, 'dict');
  writeFileSync(dictFile, dict);
  const one = Buffer.from(record(1234));
  write('dict.bin', dict);
  write('record.json', one);
  write('record.dict.lz4', run(['-q', '-c', '-D', dictFile], one));

  // A valid frame holding zero bytes (unlike zero bytes of input, which is not a frame).
  const empty = join(tmp, 'empty');
  writeFileSync(empty, '');
  write('empty-frame.lz4', run(['-q', '-c', empty]));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`fixtures written to ${out} with ${run(['--version']).toString().trim()}`);
console.log(readFileSync(join(out, 'corpus.txt')).length, 'bytes of corpus');
