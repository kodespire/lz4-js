# lz4-js React Native example

A bare React Native app (Hermes, New Architecture) that runs a self-test of
`@kodespire/lz4-js` on launch: round trips, frames from the lz4 CLI, truncated
input, `maxOutputSize`, raw blocks, async work off the JS thread, dictionaries
and streams. See `selftest/run.ts`.
CI runs it on an iOS simulator and an Android emulator
(`.github/workflows/react-native.yml`).

`npm install` here replaces the `file:../..` link with the package exactly as
`npm pack` would publish it (`scripts/prepare.mjs`), so build the package first:

```sh
# in the repo root
npm run build:wasm && npm run build:ts

# here
npm install
(cd ios && bundle install && bundle exec pod install)
npm run selftest:ios       # boots a simulator if none is running (IOS_SIMULATOR picks one)
npm run selftest:android   # needs ANDROID_HOME and a running emulator or device
```

`scripts/selftest.mjs` builds a Release app, installs and launches it, and
prints the `LZ4_SELFTEST` lines from the device log. It exits non-zero if any
test fails. Run `npm install` again after changing the package.
