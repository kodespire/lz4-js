// Declares the native module for React Native's codegen, which registers it with
// the app (see codegenConfig in package.json). Nothing imports this file: the module
// is written by hand in cpp/KodespireLz4Module.cpp, and src/jsi-backend.ts is its
// JavaScript side. Byte arrays are typed as Object because codegen has no Uint8Array.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  version(): string;
  compressSync(data: Object, level: number, blockSize: number, flags: number, dictionary: Object | null): Object;
  compress(data: Object, level: number, blockSize: number, flags: number, dictionary: Object | null): Promise<Object>;
  decompressSync(data: Object, dictionary: Object | null, maxOutputSize: number): Object;
  decompress(data: Object, dictionary: Object | null, maxOutputSize: number): Promise<Object>;
  compressBlockSync(data: Object, level: number, dictionary: Object | null): Object;
  compressBlock(data: Object, level: number, dictionary: Object | null): Promise<Object>;
  decompressBlockSync(data: Object, dictionary: Object | null, size: number, exact: boolean): Object;
  decompressBlock(data: Object, dictionary: Object | null, size: number, exact: boolean): Promise<Object>;
  frameContentSize(data: Object): number;
  createCStream(level: number, blockSize: number, flags: number, dictionary: Object | null): Object;
  createDStream(dictionary: Object | null, maxOutputSize: number): Object;
}

export default TurboModuleRegistry.get<Spec>('KodespireLz4');
