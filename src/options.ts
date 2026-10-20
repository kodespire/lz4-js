import {
  FLAG_BLOCK_CHECKSUM,
  FLAG_CONTENT_CHECKSUM,
  FLAG_CONTENT_SIZE,
  type BlockCompressOptions,
  type BlockDecompressOptions,
  type Bytes,
  type CompressOptions,
  type DecompressOptions,
} from './types.js';
import { DEFAULT_LEVEL, MAX_LEVEL, MIN_LEVEL } from './version.js';

const encoder = new TextEncoder();

/** LZ4_MAX_INPUT_SIZE: the largest input one raw block can hold. */
export const BLOCK_MAX_SIZE = 0x7e000000;

const BLOCK_SIZES: readonly number[] = [65536, 262144, 1048576, 4194304];

function isArrayBufferLike(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** A Uint8Array view over the caller's bytes (no copy). */
export function toBytes(input: unknown, name: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (isArrayBufferLike(input)) return new Uint8Array(input);
  throw new TypeError(`${name} must be an ArrayBuffer, a typed array, a DataView or a Buffer`);
}

/** Like toBytes, and also accepts strings (encoded as UTF-8). */
export function toInputBytes(input: unknown): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : toBytes(input, 'data');
}

// Unknown keys throw instead of being ignored, so a typo such as
// `{ compressionLevel: 9 }` cannot silently compress at the default level.
function checkKeys(options: object, allowed: readonly string[], fn: string, hints: Record<string, string> = {}): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      const hint = hints[key] ??
        (key.toLowerCase().includes('level') && allowed.includes('level') ? ' Did you mean "level"?' : '');
      throw new TypeError(`${fn}: unknown option "${key}". Valid options: ${allowed.join(', ')}.${hint}`);
    }
  }
}

function checkOptionsObject(options: unknown, fn: string): void {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new TypeError(`${fn}: options must be an object`);
  }
}

function checkLevel(level: unknown, fn: string): number {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`${fn}: level must be an integer from ${MIN_LEVEL} to ${MAX_LEVEL}, got ${String(level)}`);
  }
  return level;
}

function checkBoolean(value: unknown, name: string, fn: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${fn}: ${name} must be a boolean`);
  return value;
}

// Only a missing (undefined) option takes the default: `{ level: null }` is an error, not level 1.
function or<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function optionalDictionary(value: Bytes | undefined): Uint8Array | null {
  const dictionary = value === undefined ? null : toBytes(value, 'dictionary');
  return dictionary && dictionary.length > 0 ? dictionary : null;
}

export interface ResolvedCompressOptions {
  level: number;
  blockSize: number;
  /** FLAG_* bits. */
  flags: number;
  dictionary: Uint8Array | null;
}

const COMPRESS_KEYS = ['level', 'contentChecksum', 'blockChecksum', 'blockSize', 'contentSize', 'dictionary'] as const;
const STREAM_KEYS = COMPRESS_KEYS.filter((key) => key !== 'contentSize');
const COMPRESS_HINTS = { checksum: ' Did you mean "contentChecksum"?' };
const STREAM_HINTS = {
  ...COMPRESS_HINTS,
  contentSize: ' A stream does not know the total size, so it cannot record it.',
};

export function resolveCompressOptions(
  options: CompressOptions | number | undefined,
  fn: string,
  stream = false,
): ResolvedCompressOptions {
  if (typeof options === 'number') options = { level: options };
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, stream ? STREAM_KEYS : COMPRESS_KEYS, fn, stream ? STREAM_HINTS : COMPRESS_HINTS);
  const level = checkLevel(or(options?.level, DEFAULT_LEVEL), fn);
  const blockSize = or<number>(options?.blockSize, 65536);
  if (!BLOCK_SIZES.includes(blockSize)) {
    throw new RangeError(`${fn}: blockSize must be one of ${BLOCK_SIZES.join(', ')}, got ${String(blockSize)}`);
  }
  let flags = 0;
  if (checkBoolean(or(options?.contentChecksum, true), 'contentChecksum', fn)) flags |= FLAG_CONTENT_CHECKSUM;
  if (checkBoolean(or(options?.blockChecksum, false), 'blockChecksum', fn)) flags |= FLAG_BLOCK_CHECKSUM;
  if (!stream && checkBoolean(or(options?.contentSize, true), 'contentSize', fn)) flags |= FLAG_CONTENT_SIZE;
  return { level, blockSize, flags, dictionary: optionalDictionary(options?.dictionary) };
}

export interface ResolvedDecompressOptions {
  maxOutputSize: number;
  dictionary: Uint8Array | null;
}

const DECOMPRESS_KEYS = ['maxOutputSize', 'dictionary'] as const;

function checkLimit(value: unknown, name: string, fn: string, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 ||
      (Number.isFinite(value) && !Number.isInteger(value)) || value > max) {
    const range = max === Infinity ? 'a non-negative integer or Infinity' : `an integer from 0 to ${max}`;
    throw new RangeError(`${fn}: ${name} must be ${range}`);
  }
  return value;
}

export function resolveDecompressOptions(options: DecompressOptions | undefined, fn: string): ResolvedDecompressOptions {
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, DECOMPRESS_KEYS, fn);
  const maxOutputSize = checkLimit(or(options?.maxOutputSize, Infinity), 'maxOutputSize', fn, Infinity);
  return { maxOutputSize, dictionary: optionalDictionary(options?.dictionary) };
}

export interface ResolvedBlockCompressOptions {
  level: number;
  dictionary: Uint8Array | null;
}

const BLOCK_COMPRESS_KEYS = ['level', 'dictionary'] as const;

export function resolveBlockCompressOptions(options: BlockCompressOptions | number | undefined, fn: string): ResolvedBlockCompressOptions {
  if (typeof options === 'number') options = { level: options };
  checkOptionsObject(options, fn);
  if (options) checkKeys(options, BLOCK_COMPRESS_KEYS, fn);
  return { level: checkLevel(or(options?.level, DEFAULT_LEVEL), fn), dictionary: optionalDictionary(options?.dictionary) };
}

export interface ResolvedBlockDecompressOptions {
  size: number;
  /** true: `size` is the exact original size; false: an upper bound. */
  exact: boolean;
  dictionary: Uint8Array | null;
}

const BLOCK_DECOMPRESS_KEYS = ['originalSize', 'maxOutputSize', 'dictionary'] as const;

export function resolveBlockDecompressOptions(options: BlockDecompressOptions | number, fn: string): ResolvedBlockDecompressOptions {
  if (typeof options === 'number') options = { originalSize: options };
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`${fn}: pass the original size, or options with originalSize or maxOutputSize`);
  }
  checkKeys(options, BLOCK_DECOMPRESS_KEYS, fn);
  const { originalSize, maxOutputSize } = options as { originalSize?: unknown; maxOutputSize?: unknown };
  if ((originalSize === undefined) === (maxOutputSize === undefined)) {
    throw new TypeError(
      `${fn}: pass exactly one of originalSize (the exact size) or maxOutputSize (an upper bound): a raw LZ4 block does not record its size`,
    );
  }
  const exact = originalSize !== undefined;
  const size = checkLimit(exact ? originalSize : maxOutputSize, exact ? 'originalSize' : 'maxOutputSize', fn, BLOCK_MAX_SIZE);
  return { size, exact, dictionary: optionalDictionary(options.dictionary) };
}

export type { Bytes };
