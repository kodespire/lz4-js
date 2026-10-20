// Compiles src/ to dist/ and copies the files tsc does not handle.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const wasm = join(root, 'out', 'wasm', 'lz4.wasm');

if (!existsSync(wasm)) {
  console.error('out/wasm/lz4.wasm is missing. Run `npm run build:wasm` first.');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', root], {
  stdio: 'inherit',
});
copyFileSync(wasm, join(dist, 'lz4.wasm'));
copyFileSync(join(root, 'src', 'entry-workerd.js'), join(dist, 'entry-workerd.js'));
console.log('built dist/');
