// Must match deps/lz4 and csrc/ljs.c (checked by test/version.test.ts).
/** Version of the bundled lz4 library, the same for the native and WebAssembly builds. */
export const LZ4_VERSION = '1.10.0';
/** Fastest (lowest-ratio) compression level: the fast compressor at acceleration 65537. */
export const MIN_LEVEL = -65536;
/** Highest-ratio compression level (LZ4 HC with the optimal parser). */
export const MAX_LEVEL = 12;
/** Level used when none is given: the fast compressor, as with the lz4 command-line tool. */
export const DEFAULT_LEVEL = 1;
/** Levels from this one up use LZ4 HC (high compression). Below it, the fast compressor. */
export const HC_MIN_LEVEL = 2;
