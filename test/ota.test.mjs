// Nexus ad98fbf6: the host's remote "check/apply update now" for the
// paired badge — GET/POST /api/badge/ota-* proxying to the badge's own
// token-gated /ota-status, /ota-check, /ota-update (QACode_27's
// Console/OtaWorker.cpp). Same fakeBadge-over-a-real-port approach
// server-e2e.test.mjs uses for /pair + /cards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-ota-test-'));
setScratchHome(scratch);

// server.mjs's start() always also binds its action-server listener to
// ACTION_PORT, a module-level const read from this env var at import time
// (default 4174) — independent of whatever hostPort a given start() call
// uses. server-e2e.test.mjs already starts a real server on the default,
// and node's test runner runs separate test files in parallel processes,
// so without this we'd race it for the same port. ACTION_PORT must be set
// before server.mjs is imported, since it's read once at module load.
process.env.BADGE_CONSOLE_ACTION_PORT = '41739';

const { start, stop } = await import('../src/server.mjs');

function fakeBadge({ deviceToken = 'test-token-123', simulateRestartOnUpdate = false } = {}) {
  const requests = [];
  let availableVersion = null;
  let checking = false;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, token: req.headers['x-auth-token'] });

    if (req.method === 'POST' && req.url === '/pair') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: deviceToken }));
      });
      return;
    }

    if (req.headers['x-auth-token'] !== deviceToken) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('bad token');
      return;
    }

    if (req.method === 'GET' && req.url === '/ota-status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ currentVersion: '2.3.9', availableVersion, checking }));
      return;
    }

    if (req.method === 'POST' && req.url === '/ota-check') {
      availableVersion = '2.4.0'; // simulate the periodic/manual check finding something newer
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/ota-update') {
      if (!availableVersion) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no update available - POST /ota-check first' }));
        return;
      }
      if (simulateRestartOnUpdate) {
        // Mirrors OTA::installUpdate()'s success path: the badge restarts
        // mid-response and the connection just drops, no HTTP response
        // ever gets sent.
        req.socket.destroy();
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'update download/flash failed - still running current firmware' }));
      return;
    }

    res.writeHead(404); res.end();
  });

  return { server, requests, setAvailable: (v) => { availableVersion = v; } };
}

async function pairedHost(t, badgeOpts, hostPort) {
  const badge = fakeBadge(badgeOpts);
  await new Promise((resolve) => badge.server.listen(0, '127.0.0.1', resolve));
  const badgePort = badge.server.address().port;

  await start(hostPort);
  t.after(async () => {
    await stop();
    await new Promise((resolve) => badge.server.close(resolve));
  });

  const base = `http://127.0.0.1:${hostPort}`;
  const pairRes = await fetch(`${base}/api/badge/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: badgePort, code: '000000' }),
  });
  assert.equal(pairRes.status, 200);
  return { badge, base };
}

test('ota-status/ota-check/ota-update are 409 before the badge is paired', async (t) => {
  const hostPort = 41741;
  await start(hostPort);
  t.after(() => stop());
  const base = `http://127.0.0.1:${hostPort}`;

  for (const [path, method] of [['/api/badge/ota-status', 'GET'], ['/api/badge/ota-check', 'POST'], ['/api/badge/ota-update', 'POST']]) {
    const res = await fetch(`${base}${path}`, { method });
    assert.equal(res.status, 409, `${method} ${path}`);
  }
});

test('ota-status reports the badge\'s current version and no update by default', async (t) => {
  const { base } = await pairedHost(t, {}, 41742);
  const res = await fetch(`${base}/api/badge/ota-status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.currentVersion, '2.3.9');
  assert.equal(body.availableVersion, null);
});

test('ota-check then ota-status shows the newer version, token carried through', async (t) => {
  const { badge, base } = await pairedHost(t, {}, 41743);

  const checkRes = await fetch(`${base}/api/badge/ota-check`, { method: 'POST' });
  assert.equal(checkRes.status, 200);

  const statusRes = await fetch(`${base}/api/badge/ota-status`);
  const status = await statusRes.json();
  assert.equal(status.availableVersion, '2.4.0');

  const otaRequests = badge.requests.filter((r) => r.url.startsWith('/ota-'));
  assert.ok(otaRequests.every((r) => r.token === 'test-token-123'), 'every /ota-* call carries the paired device token');
});

test('ota-update with nothing available comes back as a clean error, not a crash', async (t) => {
  const { base } = await pairedHost(t, {}, 41744);
  const res = await fetch(`${base}/api/badge/ota-update`, { method: 'POST' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /no update available/);
});

test('ota-update whose badge restarts mid-response reports ok:true, restarted:true — not a thrown error', async (t) => {
  const { base } = await pairedHost(t, { simulateRestartOnUpdate: true }, 41745);

  await fetch(`${base}/api/badge/ota-check`, { method: 'POST' }); // make an update available first

  const res = await fetch(`${base}/api/badge/ota-update`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.restarted, true);
});
