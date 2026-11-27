// Single source of truth for the running version, usable from both a plain
// `node src/server.mjs` dev run and the bundled SEA binary. esbuild's
// `define` (scripts/build-sea.mjs) replaces __APP_VERSION__ with a quoted
// string literal at bundle time, so this file never reaches for fs/package.json
// inside the SEA build (which has no package.json sitting next to it on disk —
// see docs/DECISIONS.md "Single-executable packaging"). `typeof` is used
// specifically because it's the one way to read an undeclared identifier
// without a ReferenceError, which is what lets the exact same source run
// unbundled too.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;
if (!VERSION) {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    VERSION = '0.0.0-dev';
  }
}

export default VERSION;
