// Prints the liblz4 C sources that both builds compile, one per line.
// Used by binding.gyp (via <!@(...)) and scripts/build-wasm.mjs.
//
// Only lib/, which is BSD-2-Clause. deps/lz4/programs (the lz4 CLI) is GPL and
// must never be compiled into the package; lib/lz4file.c is not needed either.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const FILES = ['lz4.c', 'lz4hc.c', 'lz4frame.c', 'xxhash.c'];

function sources() {
  return FILES.map((name) => {
    const rel = path.posix.join('deps/lz4/lib', name);
    if (!fs.existsSync(path.join(root, rel))) {
      throw new Error(`${rel} is missing. Run: git submodule update --init`);
    }
    return rel;
  });
}

module.exports = { sources };

if (require.main === module) {
  process.stdout.write(sources().join('\n') + '\n');
}
