#!/usr/bin/env bash
# Builds the Linux prebuild for the runner's architecture inside a container, so
# the binary links against an old C library and runs on most distributions:
#   glibc: manylinux_2_28 (glibc 2.28: RHEL/Alma/Rocky 8+, Debian 10+, Ubuntu 18.10+)
#   musl:  Alpine
# Usage: scripts/ci/prebuild-linux.sh glibc|musl
set -euo pipefail
libc="$1"
case "$(uname -m)" in
  x86_64) arch=x64; manylinux=quay.io/pypa/manylinux_2_28_x86_64 ;;
  aarch64 | arm64) arch=arm64; manylinux=quay.io/pypa/manylinux_2_28_aarch64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if [ "$libc" = glibc ]; then
  docker run --rm -v "$PWD:/w" -w /w "$manylinux" bash -euo pipefail -c "
    tarball=\$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o 'node-v[0-9.]*-linux-$arch.tar.xz' | head -1)
    curl -fsSL https://nodejs.org/dist/latest-v22.x/\$tarball | tar -xJ -C /opt
    export PATH=/opt/\${tarball%.tar.xz}/bin:\$PATH
    npm ci --ignore-scripts --no-audit --no-fund
    npx prebuildify --napi --strip --tag-libc --target 22.0.0
  "
elif [ "$libc" = musl ]; then
  docker run --rm -v "$PWD:/w" -w /w node:22-alpine sh -euc "
    apk add --no-cache build-base python3 >/dev/null
    npm ci --ignore-scripts --no-audit --no-fund
    npx prebuildify --napi --strip --tag-libc --target 22.0.0
  "
else
  echo "usage: $0 glibc|musl" >&2
  exit 1
fi
ls -la prebuilds/*
