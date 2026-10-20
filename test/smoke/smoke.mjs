// Smoke test for an installed copy of the package, runnable under Node, Bun and Deno:
//   EXPECT_BACKEND=native node smoke.mjs
//   EXPECT_BACKEND=native bun smoke.mjs
//   EXPECT_BACKEND=wasm deno run -A --node-modules-dir=manual smoke.mjs
// Copy it next to a node_modules that has @kodespire/lz4-js installed.
import * as z from '@kodespire/lz4-js';

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  globalThis.process?.exit?.(1);
  globalThis.Deno?.exit?.(1);
  throw new Error(message);
};
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const runtime = globalThis.Deno ? `deno ${Deno.version.deno}` : globalThis.Bun ? `bun ${Bun.version}` : `node ${process.version}`;
const src = new TextEncoder().encode('smoke test '.repeat(50_000));

const frame = await z.compress(src, { level: 9 });
if (!equal(await z.decompress(frame), src)) fail('async round trip');
await z.init();
if (!equal(z.decompressSync(z.compressSync(src)), src)) fail('sync round trip');
const block = await z.compressBlock(src);
if (!equal(await z.decompressBlock(block, src.length), src)) fail('block round trip');

let code;
try {
  await z.decompress(frame.subarray(0, frame.length - 3));
} catch (error) {
  code = error.code;
}
if (code !== 'ERR_LZ4_TRUNCATED') fail(`truncated input gave ${code}`);

const streamed = await new Response(new Blob([src]).stream().pipeThrough(z.createCompressStream()).pipeThrough(z.createDecompressStream())).arrayBuffer();
if (!equal(new Uint8Array(streamed), src)) fail('stream round trip');

const backend = z.activeBackend();
const expected = globalThis.process?.env?.EXPECT_BACKEND ?? globalThis.Deno?.env.get('EXPECT_BACKEND');
if (expected && backend !== expected) fail(`backend is ${backend}, expected ${expected}`);

console.log(`ok: ${runtime}, backend=${backend}, lz4 ${z.LZ4_VERSION}, ${src.length} -> ${frame.length} bytes (frame), ${block.length} bytes (block)`);
