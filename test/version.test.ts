import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as constants from '../src/version.js';

const lib = join(import.meta.dirname, '..', 'deps', 'lz4', 'lib');
const define = (file: string, name: string) =>
  Number(new RegExp(`#define ${name}\\s+(\\d+)`).exec(readFileSync(join(lib, file), 'utf8'))![1]);

describe('version constants', () => {
  it('LZ4_VERSION matches deps/lz4/lib/lz4.h', () => {
    expect(constants.LZ4_VERSION).toBe(
      `${define('lz4.h', 'LZ4_VERSION_MAJOR')}.${define('lz4.h', 'LZ4_VERSION_MINOR')}.${define('lz4.h', 'LZ4_VERSION_RELEASE')}`,
    );
  });

  it('level constants match deps/lz4/lib/lz4hc.h', () => {
    expect(constants.MAX_LEVEL).toBe(define('lz4hc.h', 'LZ4HC_CLEVEL_MAX'));
    expect(constants.HC_MIN_LEVEL).toBe(define('lz4hc.h', 'LZ4HC_CLEVEL_MIN'));
  });

  it('level constants match the compiled library (native addon and WebAssembly)', async () => {
    const require = createRequire(import.meta.url);
    const addon = require('node-gyp-build')(join(import.meta.dirname, '..'));
    const wasm = await WebAssembly.instantiate(readFileSync(join(import.meta.dirname, '..', 'dist', 'lz4.wasm')), {
      env: { emscripten_notify_memory_growth() {} },
    });
    const e = wasm.instance.exports as Record<string, () => number>;
    for (const [minLevel, maxLevel, defaultLevel] of [
      [addon.minLevel, addon.maxLevel, addon.defaultLevel],
      [e['ljs_min_level']!(), e['ljs_max_level']!(), e['ljs_default_level']!()],
    ]) {
      expect(minLevel).toBe(constants.MIN_LEVEL);
      expect(maxLevel).toBe(constants.MAX_LEVEL);
      expect(defaultLevel).toBe(constants.DEFAULT_LEVEL);
    }
    expect(addon.version).toBe(constants.LZ4_VERSION);
  });
});
