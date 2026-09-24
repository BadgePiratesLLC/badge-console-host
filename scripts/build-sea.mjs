#!/usr/bin/env node
// Builds a single-file executable using Node's built-in Single Executable
// Application support (stable since Node 22, used here on Node >=20 per
// package.json's engines field — CI pins a Node version new enough).
// Intentionally not pkg/nexe/etc: both are unmaintained or unfavored for
// new projects, and Node's own SEA tooling needs zero extra dependencies,
// consistent with this repo's zero-npm-dependency stance (docs/DECISIONS.md).
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_NAME = process.platform === 'win32' ? 'badge-console-host.exe' : 'badge-console-host';

fs.mkdirSync(DIST, { recursive: true });

const seaConfigPath = path.join(DIST, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify({
  main: path.join(ROOT, 'src', 'server.mjs'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
}, null, 2));

console.log('1/4 generating SEA blob…');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

const outPath = path.join(DIST, OUT_NAME);
console.log('2/4 copying node binary…');
fs.copyFileSync(process.execPath, outPath);
fs.chmodSync(outPath, 0o755);

console.log('3/4 removing any existing signature (macOS)…');
if (process.platform === 'darwin') {
  try { execFileSync('codesign', ['--remove-signature', outPath]); } catch { /* not fatal */ }
}

console.log('4/4 injecting the blob…');
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
