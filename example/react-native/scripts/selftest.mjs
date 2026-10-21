// Builds the example app (Release, so the JS bundle is inside the app), installs it on
// a booted iOS simulator or Android emulator, launches it, and waits for the
// self-test's `LZ4_SELFTEST DONE` line in the device log. Exits 1 on any failure.
//
//   node scripts/selftest.mjs ios|android [--skip-build]
//
// iOS: uses the booted simulator, or boots IOS_SIMULATOR (a name or UDID).
// Android: uses the device adb sees (start an emulator first). Needs ANDROID_HOME.
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const platform = process.argv[2];
const skipBuild = process.argv.includes('--skip-build');
const timeoutMs = Number(process.env.SELFTEST_TIMEOUT_MS ?? 10 * 60_000);
const MARK = 'LZ4_SELFTEST ';
const appName = JSON.parse(readFileSync(join(app, 'app.json'), 'utf8')).name;

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

function capture(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...options }).trim();
}

// Follows a log process until the DONE line; resolves with whether everything passed.
function watch(child) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    let failed = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no ${MARK}DONE line within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      buffered += data;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        const at = line.indexOf(MARK);
        if (at < 0) continue;
        const message = line.slice(at + MARK.length).trim();
        console.log(message);
        if (message.startsWith('FAIL')) failed = true;
        const done = /^DONE passed=(\d+) failed=(\d+)/.exec(message);
        if (done) {
          clearTimeout(timer);
          child.kill();
          resolve(!failed && done[2] === '0' && Number(done[1]) > 0);
        }
      }
    });
    child.on('error', reject);
  });
}

async function ios() {
  const devices = JSON.parse(capture('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])).devices;
  const all = Object.values(devices).flat();
  const wanted = process.env.IOS_SIMULATOR;
  let device = wanted
    ? all.find((d) => d.udid === wanted || d.name === wanted)
    : all.find((d) => d.state === 'Booted') ?? all.find((d) => d.name.startsWith('iPhone'));
  if (!device) throw new Error(`no simulator found${wanted ? ` named ${wanted}` : ''}`);
  if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
  run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);

  const derived = join(app, 'ios', 'build', 'selftest');
  if (!skipBuild) {
    run('xcodebuild', [
      '-workspace', `${appName}.xcworkspace`, '-scheme', appName, '-configuration', 'Release',
      '-sdk', 'iphonesimulator', '-destination', `id=${device.udid}`, '-derivedDataPath', derived,
      'build',
    ], { cwd: join(app, 'ios') });
  }
  const products = join(derived, 'Build', 'Products', 'Release-iphonesimulator');
  const bundle = readdirSync(products).find((name) => name.endsWith('.app'));
  if (!bundle) throw new Error(`no .app in ${products}`);
  const appPath = join(products, bundle);
  const bundleId = capture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(appPath, 'Info.plist')]);

  try {
    execFileSync('xcrun', ['simctl', 'terminate', device.udid, bundleId], { stdio: 'ignore' });
  } catch {
    // not running
  }
  run('xcrun', ['simctl', 'install', device.udid, appPath]);
  const log = spawn('xcrun', [
    'simctl', 'spawn', device.udid, 'log', 'stream', '--style', 'compact', '--level', 'info',
    '--predicate', `process == "${bundle.replace(/\.app$/, '')}"`,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = watch(log);
  // Give `log stream` a moment to attach before the app starts logging.
  await new Promise((r) => setTimeout(r, 3000));
  run('xcrun', ['simctl', 'launch', device.udid, bundleId]);
  return result;
}

async function android() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('set ANDROID_HOME to the Android SDK');
  const adb = join(sdk, 'platform-tools', 'adb');
  run(adb, ['wait-for-device']);
  while (capture(adb, ['shell', 'getprop', 'sys.boot_completed']) !== '1') {
    await new Promise((r) => setTimeout(r, 2000));
  }
  const abi = capture(adb, ['shell', 'getprop', 'ro.product.cpu.abi']);
  const androidDir = join(app, 'android');
  if (!skipBuild) {
    run('./gradlew', [':app:assembleRelease', `-PreactNativeArchitectures=${abi}`, '--console=plain'], { cwd: androidDir });
  }
  const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const appId = /applicationId\s+"([^"]+)"/.exec(readFileSync(join(androidDir, 'app', 'build.gradle'), 'utf8'))[1];
  run(adb, ['install', '-r', apk]);
  run(adb, ['shell', 'am', 'force-stop', appId]);
  run(adb, ['logcat', '-c']);
  const log = spawn(adb, ['logcat', '-v', 'brief', 'ReactNativeJS:I', '*:S'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const result = watch(log);
  run(adb, ['shell', 'am', 'start', '-W', '-n', `${appId}/.MainActivity`]);
  return result;
}

const runners = { ios, android };
if (!runners[platform]) {
  console.error('usage: node scripts/selftest.mjs ios|android [--skip-build]');
  process.exit(2);
}
runners[platform]().then(
  (ok) => {
    console.log(ok ? 'self-test passed' : 'self-test FAILED');
    process.exit(ok ? 0 : 1);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
