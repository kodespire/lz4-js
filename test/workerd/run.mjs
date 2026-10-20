// Starts `wrangler dev` on worker.mjs in the current directory (a project with
// @kodespire/lz4-js and wrangler installed), requests it, and checks the result.
//   cp worker.mjs wrangler.toml run.mjs <project> && cd <project> && node run.mjs
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const port = 8799;
// Run wrangler directly (not through npx) in its own process group, so the
// whole tree, including workerd, can be stopped at the end.
const wrangler = spawn(join('node_modules', '.bin', 'wrangler'), ['dev', '--port', String(port), '--ip', '127.0.0.1'], {
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let log = '';
wrangler.stdout.on('data', (d) => (log += d));
wrangler.stderr.on('data', (d) => (log += d));

let result;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && wrangler.exitCode === null) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) });
    result = await response.json();
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
try {
  process.kill(-wrangler.pid, 'SIGTERM');
} catch {}

const ok = result && !result.error && result.roundTrip && result.sync && result.stream &&
  result.truncated === 'ERR_LZ4_TRUNCATED' && result.block && result.backend === 'wasm';
console.log(ok ? 'ok: workerd' : 'FAIL: workerd', JSON.stringify(result));
if (!ok) console.log(log);
process.exit(ok ? 0 : 1);
