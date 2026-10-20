# lz4-js

[![CI](https://github.com/kodespire/lz4-js/actions/workflows/ci.yml/badge.svg)](https://github.com/kodespire/lz4-js/actions/workflows/ci.yml)

LZ4 compression for Node.js, Bun, Deno, browsers and edge runtimes, with one API everywhere.

- **The official library.** Compiled from [lz4/lz4](https://github.com/lz4/lz4) v1.10.0, pinned as a git submodule. Only its BSD-licensed `lib/` is compiled in. A weekly job opens a PR when upstream releases.
- **Native where possible, WebAssembly everywhere else.** Node.js and Bun use a Node-API addon. Browsers, Deno and Workers use WebAssembly built from the same C code. If no prebuilt binary matches your platform, the package switches to WebAssembly on its own.
- **No install scripts.** Prebuilt binaries ship inside the package. `npm install` never downloads or compiles anything.
- **Never returns partial data.** Cut-off frames, corrupt input and output over your size limit all throw. They never return what was decoded so far. (Decompress streams pass data on as it decodes, and then error. See [Streams](#streams).)
- **Both formats.** The frame format (what the `lz4` command-line tool reads and writes) by default, and the raw block format through separate functions.

Part of the [compression-js](https://github.com/kodespire/compression-js) family.

```sh
npm install @kodespire/lz4-js
```

## Usage

```js
import { compress, decompress } from '@kodespire/lz4-js';

const packed = await compress(data); // or compress(data, 9) for LZ4 HC
const unpacked = await decompress(packed, { maxOutputSize: 64 * 1024 * 1024 });
```

`data` can be a `Uint8Array`, a Node `Buffer`, an `ArrayBuffer`, any typed array or `DataView`, or a string (encoded as UTF-8). Results are always `Uint8Array`.

Output interoperates with the `lz4` command-line tool in both directions: `lz4 -d` decodes what `compress` writes, and `decompress` decodes what `lz4` writes, including `lz4 -D dict` dictionary frames.

### Frames and blocks

LZ4 has two formats, and this package keeps them apart:

| | Frame format | Block format |
| --- | --- | --- |
| Functions | `compress`, `decompress`, streams | `compressBlock`, `decompressBlock` |
| What it is | Header, blocks, end mark, checksums | Just the compressed bytes |
| Records its size | Yes (`contentSize`, on by default for one-shot calls) | No: you must store it |
| Detects cut-off input | Always (the end mark is required) | Only with `originalSize` |
| Detects corruption | With the content checksum (on by default) | No |
| Compatible with | `lz4` CLI, `.lz4` files, most LZ4 libraries | Formats that frame blocks themselves |

Use frames unless a protocol or file format asks for raw blocks. A block carries no header, so decompressing it needs the original size:

```js
import { compressBlock, decompressBlock } from '@kodespire/lz4-js';

const block = await compressBlock(data);
// ...store data.length alongside the block...
const restored = await decompressBlock(block, data.length); // same as { originalSize: data.length }
```

- With **`originalSize`** (or just the number), the block must decode to exactly that many bytes. Fewer throws `ERR_LZ4_TRUNCATED`, more throws `ERR_LZ4_OUTPUT_LIMIT`. Every cut-off block is caught.
- With **`maxOutputSize`**, the block may decode to anything up to that size. More throws `ERR_LZ4_OUTPUT_LIMIT`. The block format has no end marker, so a block cut off right after a run of literals is itself a valid, shorter block. It decodes to a prefix of the original without an error. Use this only when you don't know the size, and check the length yourself if you can.

Either way, a raw block has no checksum: corruption can decode to wrong bytes of the right length. Corrupt input never reads or writes out of bounds, and never produces more than the size you passed.

### Streams

`createCompressStream()` and `createDecompressStream()` return standard [`TransformStream`](https://developer.mozilla.org/docs/Web/API/TransformStream)s, which work in every runtime:

```js
const response = await fetch(url);
const body = response.body.pipeThrough(createDecompressStream());
```

In Node.js, wrap them with `Duplex.fromWeb` to use them in a pipeline:

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createCompressStream } from '@kodespire/lz4-js';

await pipeline(
  createReadStream('data.json'),
  Duplex.fromWeb(createCompressStream({ level: 9 })),
  createWriteStream('data.json.lz4'),
);
```

A compress stream never knows the total size, so its frame does not record one, and `contentSize` is not one of its options.

A decompress stream passes data on as soon as it is decoded. If the input then turns out to be cut off, corrupt or over `maxOutputSize`, the stream errors. Whatever it already produced is a prefix of the content, and must be discarded, like a failed download.

### Synchronous calls

`compressSync`, `decompressSync`, `compressBlockSync` and `decompressBlockSync` behave like their async versions.

- **Node.js and Bun:** they work right away.
- **Browsers, Deno and Workers:** the WebAssembly module loads asynchronously, so call `await init()` once first.

The async functions load the module on demand. Like the sync ones, they read your input before returning, so you can reuse the buffer right away.

```js
import { init, compressSync } from '@kodespire/lz4-js';

await init();
const packed = compressSync('hello');
```

### Untrusted input

A few KB of LZ4 can expand to megabytes (up to about 255 times its size). Always pass `maxOutputSize` when decompressing frames you don't control. Decoding stops as soon as the limit is crossed:

```js
try {
  await decompress(upload, { maxOutputSize: 10 * 1024 * 1024 });
} catch (error) {
  if (error.code === 'ERR_LZ4_OUTPUT_LIMIT') rejectUpload();
}
```

Size fields in frame headers are untrusted too. They only size the first allocation (capped at 64 MiB), and a frame whose data does not match its recorded size is rejected.

### Dictionaries

Small, similar payloads (JSON records, log lines) compress much better with a dictionary. For LZ4, any bytes that resemble the data work: typical records, or a dictionary trained with `zstd --train`. Only the last 64 KiB is used.

```js
const packed = await compress(record, { dictionary });
const unpacked = await decompress(packed, { dictionary });
```

Blocks take a `dictionary` option the same way.

## API

| Function | Description |
| --- | --- |
| `compress(data, options?)` | Compresses into one LZ4 frame. Returns `Promise<Uint8Array>`. |
| `decompress(data, options?)` | Decompresses every frame in `data`. Returns `Promise<Uint8Array>`. |
| `compressBlock(data, options?)` | Compresses into one raw block. Input up to 2113929216 bytes. |
| `decompressBlock(data, originalSize \| options)` | Decompresses one raw block (see [Frames and blocks](#frames-and-blocks)). |
| `compressSync`, `decompressSync`, `compressBlockSync`, `decompressBlockSync` | Synchronous versions (see above). |
| `createCompressStream(options?)` | `TransformStream` that compresses its input into one frame. |
| `createDecompressStream(options?)` | `TransformStream` that decompresses. Errors on cut-off, corrupt or oversized input. |
| `getFrameContentSize(data)` | Size recorded in the first frame's header, `null` if it isn't recorded, `0` for a skippable frame. |
| `isLz4Frame(data)` | `true` if `data` starts with an LZ4 frame or a skippable frame. |
| `init(source?)` | Loads the backend. `source` can be a URL, `Response`, bytes or `WebAssembly.Module` for `lz4.wasm`. |
| `activeBackend()` | `'native'` or `'wasm'`. |
| `LZ4_VERSION`, `MIN_LEVEL`, `MAX_LEVEL`, `DEFAULT_LEVEL`, `HC_MIN_LEVEL` | `'1.10.0'`, `-65536`, `12`, `1`, `2`. |

**Levels** work the same for frames and blocks, and match the `lz4` CLI:

| Level | Compressor | CLI equivalent |
| --- | --- | --- |
| `-1` to `-65536` | Fast, with acceleration (faster, larger output) | `--fast=1` to `--fast=65536` |
| `0`, `1` (default) | Fast | `-1` |
| `2` to `12` | LZ4 HC: slower to compress, smaller output, decodes just as fast | `-2` to `-12` |

A number in place of the options object sets just the level: `compress(data, 9)`.

**Compress options**

| Option | Default | |
| --- | --- | --- |
| `level` | `1` | See above. |
| `contentChecksum` | `true` | Adds a 4-byte checksum of the content, so corruption is detected when decompressing. |
| `blockChecksum` | `false` | Adds a 4-byte checksum after each block. |
| `blockSize` | `65536` | Largest block: `65536`, `262144`, `1048576` or `4194304`. Decoders need about twice this much memory. Input that fits in a smaller block size is written with that size. |
| `contentSize` | `true` | Records the uncompressed size in the header (8 bytes). Not available on streams. An empty input's size can't be recorded, because the format reads 0 as unknown. |
| `dictionary` | none | Compress with a dictionary. |

Blocks within a frame are linked: each may refer back into the previous 64 KiB, which compresses better than independent blocks. Every decoder handles both.

**Decompress options:** `maxOutputSize` (default `Infinity`) throws `ERR_LZ4_OUTPUT_LIMIT` rather than produce more bytes; `dictionary` gives the dictionary the data was compressed with.

**Block options:** `compressBlock` takes `level` and `dictionary`. `decompressBlock` takes exactly one of `originalSize` or `maxOutputSize` (each from `0` to `2113929216`), plus an optional `dictionary`.

An unknown option name throws a `TypeError`. A typo like `{ compressionLevel: 9 }` fails loudly instead of quietly compressing at level 1.

**Errors** are `Lz4Error` instances, each with a `code`:

| Code | Meaning |
| --- | --- |
| `ERR_LZ4_TRUNCATED` | The input ended partway through a frame, or was empty; or a block decoded to fewer bytes than `originalSize`. |
| `ERR_LZ4_OUTPUT_LIMIT` | The output would exceed `maxOutputSize`, or a block's `originalSize`. |
| `ERR_LZ4_LIBRARY` | lz4 rejected the data: corrupt input, checksum mismatch, wrong dictionary, not LZ4. |
| `ERR_LZ4_NOT_INITIALIZED` | A sync function was called in a browser or Worker before `await init()`. |
| `ERR_LZ4_OUT_OF_MEMORY`, `ERR_LZ4_INVALID_ARGUMENT` | As named. |

## Behaviour details

- **Empty input is an error** (`ERR_LZ4_TRUNCATED`), the same as the `lz4` command-line tool. Compressing an empty input gives a valid 15-byte frame, and that frame decompresses back to empty. For blocks, empty input compresses to the 1-byte block `[0]`.
- **Concatenated frames** decompress to the concatenated contents, as `lz4 -d` does. **Skippable frames** are skipped. Because joined frames are valid LZ4, input cut off exactly at a frame boundary can't be told apart from complete input. Use one frame per message if that matters.
- **The legacy format** (`lz4 -l`, used for Linux kernel images) is not supported by `decompress`, and is rejected with `ERR_LZ4_LIBRARY`. Its chunks are raw blocks, so `decompressBlock` can read them.
- **The content checksum is on by default**, unlike the liblz4 default. It costs 4 bytes per frame. Without it, corruption inside a block can decode silently to wrong bytes. The frame header has its own checksum either way.
- **The async functions use separate threads only on the native addon**, which runs them on Node's thread pool. The WebAssembly backend runs on the calling thread, so for large inputs in a browser, call it from a Web Worker.
- **Forcing WebAssembly:** set `LZ4_JS_BACKEND=wasm` in Node.js, or import `@kodespire/lz4-js/wasm` in any runtime.

## Runtimes

| Runtime | Backend | Tested in CI |
| --- | --- | --- |
| Node.js 22.12+, 24, 26 | native | Linux x64/arm64, macOS, Windows |
| Bun | native | Linux |
| Deno 2 | WebAssembly | Linux |
| Chromium, Firefox, WebKit | WebAssembly | Playwright, through Vite |
| Cloudflare Workers (`workerd` condition) | WebAssembly | `wrangler dev` (workerd) |

Prebuilt native binaries cover:
- macOS arm64 and x64
- Linux x64 and arm64 (glibc 2.28+ and musl)
- Windows x64 and arm64

Bundlers that understand `new URL('./lz4.wasm', import.meta.url)`, such as Vite, webpack 5 and Parcel, pick up the WebAssembly file automatically. For anything else, serve `@kodespire/lz4-js/lz4.wasm` yourself and pass its URL to `init()`.

## Development

```sh
git clone --recursive https://github.com/kodespire/lz4-js
npm install
npm run build:native   # Node-API addon (needs Python 3 and a C/C++ compiler)
npm run build:wasm     # lz4.wasm (needs Emscripten; see .emsdk-version)
npm run build:ts       # dist/
node scripts/build-lz4-cli.mjs   # official lz4 CLI, for the interop tests
npm test
BROWSERS=chromium npx vitest run -c vitest.browser.config.ts
```

All compression logic is in `csrc/ljs.c`, which both builds share. `csrc/addon.cc` (Node-API) and `src/wasm-backend.ts` (WebAssembly) only move bytes in and out. The tests run every case against both backends. They also check:
- decoding of output from the official CLI, and the CLI decoding ours, raw blocks included (through the legacy format)
- input cut at every byte offset, for frames and for blocks
- streaming split at random points

The lz4 CLI is GPL-licensed. It is built into `out/` for the tests only and is never part of the package.

## License

MIT. The bundled lz4 library is BSD-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
