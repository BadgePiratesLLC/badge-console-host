#!/usr/bin/env node
// Runs the actual built binary and hits it over HTTP — the only way to
// catch "the exe exits immediately" (Nexus bcae3a08: v0.1.1/v0.1.2 both
// shipped a release that crashed on startup even though `node
// scripts/build-sea.mjs` and `node --test` both exited 0). Those two
// steps only prove the build step and the source, never the artifact
// release.yml actually ships. Written in Node rather than curl/bash so
// the exact same script runs unmodified on all three release.yml
// runners — a shell-syntax difference between macOS/Linux `sh` and
// Windows `pwsh` would just be a second way for this to go unnoticed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const binPath = process.argv[2];
if (!binPath) {
  console.error('usage: node scripts/sea-smoke.mjs <path-to-built-binary>');
  process.exit(1);
}

const PORT = 15173; // not the real default (4173) — avoid colliding with a dev instance
const HOME_DIR = path.join(os.tmpdir(), `bch-smoke-${process.pid}`);
fs.mkdirSync(HOME_DIR, { recursive: true });

const child = spawn(path.resolve(binPath), [], {
  env: {
    ...process.env,
    HOME: HOME_DIR,
    USERPROFILE: HOME_DIR, // os.homedir() reads this on Windows, HOME on POSIX
    BADGE_CONSOLE_HOST_PORT: String(PORT),
    BADGE_CONSOLE_ACTION_PORT: '15174',
  },
  stdio: 'inherit',
});

let exitedEarly = false;
let killedIntentionally = false;
child.on('exit', (code, signal) => {
  if (!exitedEarly && !killedIntentionally) {
    exitedEarly = true;
    console.error(`binary exited on its own (code=${code}, signal=${signal}) before the smoke test finished`);
  }
});

async function waitForOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitedEarly) return null;
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

let failure = null;

const stateRes = await waitForOk(`http://127.0.0.1:${PORT}/api/state`, 15000);
if (!stateRes) {
  failure = '/api/state never came up within 15s';
} else {
  const body = await stateRes.json();
  if (!Array.isArray(body.feeds)) failure = `/api/state responded but with an unexpected shape: ${JSON.stringify(body).slice(0, 200)}`;
}

if (!failure) {
  const pageRes = await waitForOk(`http://127.0.0.1:${PORT}/`, 5000);
  if (!pageRes) {
    failure = 'config page "/" never responded';
  } else {
    const html = await pageRes.text();
    if (!html.includes('<html')) failure = `config page "/" responded but did not look like HTML: ${html.slice(0, 200)}`;
  }
}

killedIntentionally = true;
try { child.kill(); } catch { /* best effort */ }

if (exitedEarly && !failure) failure = 'binary exited on its own before responding';

if (failure) {
  console.error(`SMOKE TEST FAILED: ${failure}`);
  process.exit(1);
}

console.log('SMOKE TEST OK: /api/state and the config page both served from the built binary.');
