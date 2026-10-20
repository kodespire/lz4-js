// Builds the official lz4 command-line tool from deps/lz4 into out/lz4-cli/lz4,
// for generating fixtures and for interop tests. Needs make and a C compiler.
//
// The CLI (deps/lz4/programs) is GPL-2.0. It is a test tool only: nothing from
// out/ is compiled into or shipped with the package.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, 'out', 'lz4-cli');
export const cliPath = join(work, 'programs', process.platform === 'win32' ? 'lz4.exe' : 'lz4');

export function buildCli() {
  if (existsSync(cliPath)) return cliPath;
  mkdirSync(work, { recursive: true });
  // Build in a copy so the submodule's working tree stays clean.
  for (const dir of ['lib', 'programs']) {
    cpSync(join(root, 'deps', 'lz4', dir), join(work, dir), { recursive: true });
  }
  execFileSync('make', ['-j8', 'lz4'], { cwd: join(work, 'programs'), stdio: ['ignore', 'ignore', 'inherit'] });
  return cliPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(buildCli());
}
