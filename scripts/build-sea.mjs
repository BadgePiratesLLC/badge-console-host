#!/usr/bin/env node
// Builds a single-file executable using Node's built-in Single Executable
// Application support (stable since Node 22, used here on Node >=20 per
// package.json's engines field — CI pins a Node version new enough).
// Intentionally not pkg/nexe/etc: both are unmaintained or unfavored for
// new projects. esbuild bundles the ESM source to the single CJS file SEA
// requires (see below) — a devDependency of this build script only, never
// a dependency of the shipped product itself, so the zero-npm-dependency
// stance for what actually ships (docs/DECISIONS.md) still holds.
//
// Run per-platform (this only produces a binary for the OS/arch it runs
// on — see .github/workflows/release.yml for the 3-runner matrix that
// actually produces macOS/Windows/Linux artifacts; a single dev machine
// can't cross-compile a Windows binary here, which is the honest reason
// this ships as a workflow rather than a claim this script alone is
// "the" build).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_NAME = process.platform === 'win32' ? 'badge-console-host.exe' : 'badge-console-host';
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

fs.mkdirSync(DIST, { recursive: true });

// Node's SEA support only runs a CommonJS main — it does not load an ESM
// module graph at all, let alone follow this repo's relative imports out
// to plugins/ and the other src/ files (Nexus bcae3a08: the v0.1.1/v0.1.2
// release exes shipped the raw ESM src/server.mjs as `main` and crashed
// instantly with "Cannot use import statement outside a module"). esbuild
// is a devDependency only — it bundles at build time and never ships
// inside the resulting binary or the repo, so the zero-npm-dependency
// policy for the actual shipped product (docs/DECISIONS.md) still holds.
console.log('1/5 bundling to a single CJS file (Node SEA only runs CJS, not ESM)…');
const bundlePath = path.join(DIST, 'bundle.cjs');
await build({
  entryPoints: [path.join(ROOT, 'src', 'sea-entry.mjs')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // version.mjs's `typeof __APP_VERSION__` check reads this define as a
  // bundle-time constant — the SEA binary has no package.json sitting next
  // to it on disk to fall back to (see version.mjs, docs/DECISIONS.md).
  define: { __APP_VERSION__: JSON.stringify(PKG.version) },
  // esbuild empties import.meta for a cjs target and warns at every
  // remaining `import.meta.url` reference. The two left (server.mjs's
  // direct-run guard, autostart.mjs's non-SEA fallback path) are both
  // dead code in this SEA build specifically — guarded off by sea.isSea()
  // or simply never true when argv[1] isn't this script's own path — so
  // the warning would be permanent, build-time noise rather than a signal
  // of an actual bug.
  logOverride: { 'empty-import-meta': 'silent' },
});

const seaConfigPath = path.join(DIST, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify({
  main: bundlePath,
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  // A SEA doesn't follow fs reads out to files sitting next to the
  // source any more than it follows imports — web/ (the config page's
  // static HTML/JS/CSS, normally read via fs from __dirname) has to ride
  // along as embedded SEA assets instead. See server.mjs's serveStatic().
  assets: {
    'web/index.html': path.join(ROOT, 'src', 'web', 'index.html'),
    'web/app.js': path.join(ROOT, 'src', 'web', 'app.js'),
    'web/style.css': path.join(ROOT, 'src', 'web', 'style.css'),
  },
}, null, 2));

console.log('2/5 generating SEA blob…');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

const outPath = path.join(DIST, OUT_NAME);
console.log('3/5 copying node binary…');
fs.copyFileSync(process.execPath, outPath);
fs.chmodSync(outPath, 0o755);

console.log('4/5 removing any existing signature (macOS)…');
if (process.platform === 'darwin') {
  try { execFileSync('codesign', ['--remove-signature', outPath]); } catch { /* not fatal */ }
}

console.log('5/5 injecting the blob…');
// postject is only needed transiently for this one injection step and is
// run via `npx` rather than added to package.json dependencies — this
// keeps the zero-dependency policy intact for the actual shipped product
// (postject never ships inside the resulting binary or the repo).
//
// On Windows, `npx` on PATH is `npx.cmd`, not a directly-spawnable
// executable — execFileSync without `shell: true` fails with
// `spawnSync npx ENOENT` even though `npx` works fine when typed into a
// real shell. Confirmed on a real windows-latest GitHub Actions runner
// (release.yml run 36066666928) — the first time this workflow was ever
// run, since no release has shipped yet.
execFileSync('npx', ['--yes', 'postject', outPath, 'NODE_SEA_BLOB', path.join(DIST, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])],
  { stdio: 'inherit', shell: process.platform === 'win32' });

if (process.platform === 'darwin') {
  try { execFileSync('codesign', ['--sign', '-', outPath]); } catch { /* ad-hoc signing best-effort */ }
}

console.log(`Built ${outPath}`);
