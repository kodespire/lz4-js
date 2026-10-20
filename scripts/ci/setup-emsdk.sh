#!/usr/bin/env bash
# Installs the Emscripten version pinned in .emsdk-version into ~/emsdk.
# Afterwards: source ~/emsdk/emsdk_env.sh
set -euo pipefail
version="$(cat "$(dirname "$0")/../../.emsdk-version")"
if [ ! -d "$HOME/emsdk" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$HOME/emsdk"
fi
"$HOME/emsdk/emsdk" install "$version"
"$HOME/emsdk/emsdk" activate "$version"
