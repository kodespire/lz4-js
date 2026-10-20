// Builds out/wasm/lz4.wasm from the same C sources as the native addon.
// Requires Emscripten (emcc) on PATH: https://emscripten.org/docs/getting_started/
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { sources } = require('./lz4-sources.cjs');

const exported = [
  'malloc',
  'free',
  'ljs_buf_free',
  'ljs_compress',
  'ljs_decompress',
  'ljs_cstream_create',
  'ljs_cstream_push',
  'ljs_cstream_free',
  'ljs_dstream_create',
  'ljs_dstream_push',
  'ljs_dstream_finish',
  'ljs_dstream_free',
  'ljs_frame_content_size',
  'ljs_compress_block',
  'ljs_decompress_block',
  'ljs_version',
  'ljs_min_level',
  'ljs_max_level',
  'ljs_default_level',
].map((name) => `_${name}`);

const out = join(root, 'out', 'wasm', 'lz4.wasm');
mkdirSync(dirname(out), { recursive: true });

const args = [
  '-O3',
  '-flto',
  '-DNDEBUG',
  '-DXXH_NAMESPACE=LZ4_',
  '-Ideps/lz4/lib',
  'csrc/ljs.c',
  ...sources(),
  '--no-entry',
  // A plain .wasm with no Emscripten JS glue; src/wasm-backend.ts is the loader.
  '-sSTANDALONE_WASM=1',
  '-sFILESYSTEM=0',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=2MB',
  '-sMAXIMUM_MEMORY=4GB',
  '-sSTACK_SIZE=256KB',
  '-sERROR_ON_UNDEFINED_SYMBOLS=1',
  `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  '-o',
  out,
];

try {
  execFileSync('emcc', args, { cwd: root, stdio: 'inherit' });
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('emcc not found. Install Emscripten and run `source <emsdk>/emsdk_env.sh` first.');
    process.exit(1);
  }
  throw error;
}
console.log(`built ${out} (${statSync(out).size} bytes)`);
