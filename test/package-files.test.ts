// What `npm pack` publishes. React Native apps compile the native module from the
// package, so it must carry the podspec, android/, cpp/ and every C source those
// builds compile, and nothing else of the repo (the example app, build output).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const { sources } = createRequire(import.meta.url)('../scripts/lz4-sources.cjs') as { sources(): string[] };

const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }),
) as [{ files: { path: string; size: number }[] }];
const files = pack.files.map((f) => f.path.replaceAll('\\', '/'));

describe('npm package contents', () => {
  it('includes the React Native build', () => {
    for (const file of [
      'KodespireLz4.podspec',
      'react-native.config.js',
      'ios/KodespireLz4ModuleProvider.h',
      'ios/KodespireLz4ModuleProvider.mm',
      'cpp/KodespireLz4Module.h',
      'cpp/KodespireLz4Module.cpp',
      'android/build.gradle',
      'android/CMakeLists.txt',
      'android/src/main/java/com/kodespire/lz4/KodespireLz4Package.java',
      'codegen/NativeKodespireLz4.ts',
      'csrc/ljs.c',
      'csrc/ljs.h',
      'deps/lz4/lib/LICENSE',
      'dist/entry-react-native.js',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('includes every lz4 source and header the native builds compile', () => {
    for (const source of sources()) {
      expect(files).toContain(source);
      expect(files).toContain(source.replace(/\.c$/, '.h'));
    }
    expect(files).toContain('deps/lz4/lib/lz4frame_static.h');
  });

  it('leaves out the rest of the repo', () => {
    for (const file of files) {
      expect(file).not.toMatch(/^(example|test|scripts|src|out|build|\.github)\//);
      expect(file).not.toMatch(/^android\/(build|\.cxx|\.gradle)\//);
    }
    expect(files).not.toContain('binding.gyp');
    expect(files).not.toContain('csrc/addon.cc');
  });

  it('ships nothing of lz4 outside lib/', () => {
    // deps/lz4/programs (the lz4 command-line tool) is GPL; lib/ is BSD-2-Clause.
    const lz4 = files.filter((f) => f.startsWith('deps/'));
    for (const file of lz4) expect(file).toMatch(/^deps\/lz4\/lib\/[^/]+$/);
    expect(lz4).not.toContain('deps/lz4/lib/lz4file.c');
  });

  it('accepts any react-native version as a peer', () => {
    // npm treats "*" as always satisfied. A range such as ">=0.84" made installs fail
    // (ERESOLVE) next to older or prerelease React Native, even for web-only use.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.peerDependencies).toEqual({ 'react-native': '*' });
    expect(pkg.peerDependenciesMeta).toEqual({ 'react-native': { optional: true } });
  });

  it('keeps the React Native sources small', () => {
    // Everything except the JavaScript build and the Node prebuilds, unpacked.
    const native = pack.files.filter((f) => !/^(dist|prebuilds)\//.test(f.path.replaceAll('\\', '/')));
    const bytes = native.reduce((n, f) => n + f.size, 0);
    expect(bytes).toBeLessThan(1e6);
  });
});
