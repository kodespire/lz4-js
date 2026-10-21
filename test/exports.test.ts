// Which file each runtime and bundler gets from package.json "exports" and
// "imports". The expected files are what 0.1.x resolved to: adding the
// "react-native" condition must leave every existing condition set unchanged.
// The one deliberate change is the "#load-wasm" loader under Metro (react-native-web):
// 0.1.x gave it load-wasm-fetch, whose import.meta a web page cannot parse.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Target = string | null | Target[] | { [condition: string]: Target };

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  exports: Record<string, Target>;
  imports: Record<string, Target>;
};

// Node's PACKAGE_TARGET_RESOLVE: in a conditions object, the first key in object
// order that is "default" or an active condition wins. Bundlers follow the same rule.
function resolve(target: Target, conditions: readonly string[]): string | null {
  if (target === null || typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolve(t, conditions);
      if (r !== null) return r;
    }
    return null;
  }
  for (const [key, value] of Object.entries(target)) {
    if (key === 'default' || conditions.includes(key)) return resolve(value, conditions);
  }
  return null;
}

// The conditions each tool sets when it resolves an `import` of this package.
const tools: [tool: string, conditions: string[], main: string, wasm: string, loadWasm: string][] = [
  ['Node.js', ['node', 'import', 'node-addons', 'module-sync'], 'entry-node', 'entry-wasm', 'load-wasm-node'],
  ['Node.js require()', ['node', 'require', 'node-addons', 'module-sync'], 'entry-node', 'entry-wasm', 'load-wasm-node'],
  ['Bun', ['bun', 'node', 'import'], 'entry-node', 'entry-wasm', 'load-wasm-node'],
  ['Deno', ['deno', 'node', 'import'], 'entry-wasm', 'entry-wasm', 'load-wasm-node'],
  ['Cloudflare Workers (wrangler)', ['workerd', 'worker', 'browser', 'import', 'module'], 'entry-workerd', 'entry-workerd', 'load-wasm-fetch'],
  ['Vite', ['import', 'module', 'browser', 'production'], 'entry-wasm', 'entry-wasm', 'load-wasm-fetch'],
  ['Vite SSR', ['import', 'module', 'node', 'production'], 'entry-node', 'entry-wasm', 'load-wasm-node'],
  ['webpack (web)', ['webpack', 'production', 'browser', 'import', 'module'], 'entry-wasm', 'entry-wasm', 'load-wasm-fetch'],
  ['webpack (node)', ['webpack', 'production', 'node', 'import', 'module'], 'entry-node', 'entry-wasm', 'load-wasm-node'],
  ['esbuild (browser)', ['browser', 'import', 'module'], 'entry-wasm', 'entry-wasm', 'load-wasm-fetch'],
  ['Rollup (browser)', ['browser', 'import', 'module'], 'entry-wasm', 'entry-wasm', 'load-wasm-fetch'],
  // @react-native/metro-config sets "react-native" on every platform; Metro adds "browser" for web.
  ['Metro web (react-native-web)', ['react-native', 'browser', 'import', 'require'], 'entry-wasm', 'entry-wasm', 'load-wasm-react-native'],
  ['Expo web', ['browser', 'import', 'require'], 'entry-wasm', 'entry-wasm', 'load-wasm-fetch'],
  // New in 0.2: React Native on iOS and Android (Metro with the React Native CLI or Expo).
  ['Metro iOS/Android', ['react-native', 'import', 'require'], 'entry-react-native', 'entry-wasm', 'load-wasm-react-native'],
  ['No conditions', [], 'entry-wasm', 'entry-wasm', 'load-wasm-fetch'],
];

describe('package.json exports', () => {
  for (const [tool, conditions, main, wasm, loadWasm] of tools) {
    it(`${tool} [${conditions.join(', ')}]`, () => {
      expect(resolve(pkg.exports['.']!, conditions)).toBe(`./dist/${main}.js`);
      expect(resolve(pkg.exports['./wasm']!, conditions)).toBe(`./dist/${wasm}.js`);
      expect(resolve(pkg.imports['#load-wasm']!, conditions)).toBe(`./dist/${loadWasm}.js`);
      expect(resolve(pkg.exports['./lz4.wasm']!, conditions)).toBe('./dist/lz4.wasm');
    });
  }

  it('TypeScript gets the same declarations everywhere', () => {
    for (const [, conditions] of tools) {
      expect(resolve(pkg.exports['.']!, ['types', ...conditions])).toBe('./dist/public.d.ts');
      expect(resolve(pkg.exports['./wasm']!, ['types', ...conditions])).toBe('./dist/public.d.ts');
    }
  });

  it('"react-native" comes after "browser" and before "node", so web and Node never see the React Native entry', () => {
    const keys = Object.keys(pkg.exports['.']!);
    expect(keys.indexOf('react-native')).toBeGreaterThan(keys.indexOf('browser'));
    expect(keys.indexOf('react-native')).toBeLessThan(keys.indexOf('node'));
    const loaderKeys = Object.keys(pkg.imports['#load-wasm']!);
    expect(loaderKeys.indexOf('react-native')).toBeGreaterThan(loaderKeys.indexOf('node'));
  });
});

// The React Native entry is bundled by Metro and run by Hermes: no Node built-ins,
// no import.meta (Metro does not transform it), and not the "#load-wasm" import
// (which would resolve to the fetch loader, which uses import.meta).
describe('dist/entry-react-native.js', () => {
  const dist = join(import.meta.dirname, '..', 'dist');
  // Static imports and re-exports (tsc writes each at the start of a line).
  const importsOf = (source: string) =>
    [...source.matchAll(/^(?:import\s*['"]([^'"]+)['"]|(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"])/gm)].map(
      (m) => (m[1] ?? m[2])!,
    );
  const graph = new Map<string, string>();
  const visit = (file: string) => {
    if (graph.has(file)) return;
    const source = readFileSync(join(dist, file), 'utf8');
    graph.set(file, source);
    for (const spec of importsOf(source)) {
      if (spec.startsWith('./')) visit(spec.slice(2));
    }
  };
  visit('entry-react-native.js');

  it('imports only plain modules', () => {
    for (const [file, source] of graph) {
      for (const spec of importsOf(source)) {
        expect(spec.startsWith('./') || spec === 'react-native', `${file} imports ${spec}`).toBe(true);
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code.includes('import.meta'), `${file} uses import.meta`).toBe(false);
    }
    expect([...graph.keys()]).not.toContain('load-wasm-fetch.js');
    expect([...graph.keys()]).not.toContain('load-wasm-node.js');
    expect([...graph.keys()]).not.toContain('native-backend.js');
  });

  it('exports the same names as the WebAssembly entry', async () => {
    const exportsOf = (source: string) =>
      [...source.matchAll(/^export (?:const|function|class) (\w+)|^export \{([^}]+)\}|^export const \{([^}]+)\}/gm)]
        .flatMap((m) => (m[1] ?? m[2] ?? m[3]!).split(','))
        .map((name) => name.trim().split(/\s+as\s+/).pop()!)
        .filter(Boolean)
        .sort();
    const wasmEntry = readFileSync(join(dist, 'entry-wasm.js'), 'utf8');
    expect(exportsOf(graph.get('entry-react-native.js')!)).toEqual(exportsOf(wasmEntry));
  });
});
