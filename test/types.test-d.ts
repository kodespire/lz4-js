// Compile-time check (npm run typecheck): every entry point implements the
// documented API in src/public.ts, with the same names and signatures.
import type * as Public from '../src/public.js';
import type * as NodeEntry from '../src/entry-node.js';
import type * as ReactNativeEntry from '../src/entry-react-native.js';
import type * as WasmEntry from '../src/entry-wasm.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assert = <T extends true>() => undefined as unknown as T;

assert<Same<typeof NodeEntry, typeof Public>>();
assert<Same<typeof WasmEntry, typeof Public>>();
assert<Same<typeof ReactNativeEntry, typeof Public>>();
