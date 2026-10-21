// The one React Native API that entry-react-native.ts uses. react-native is an
// optional peer dependency, not installed here; react-native-web does not export it.
declare module 'react-native' {
  export const TurboModuleRegistry: { get<T>(name: string): T | null | undefined } | undefined;
}
