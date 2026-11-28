// End-to-end: start the real server, act like the config page's own
// fetch() calls, and stand up a throwaway HTTP server playing the badge to
// prove a full round trip — pair, enable a no-credential feed, test it,
// and see a real POST /cards with the right auth header land on the fake
// badge. This is the closest this repo's automated tests get to the
// ticket's own "Done when" scenario without a physical CC13.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-e2e-test-'));
setScratchHome(scratch);

// Seed a real-shaped OpenClaw invocation log so the openclaw plugin's real
// (not mocked) code path has something to read, the same way it would on
// a buyer's machine that already runs OpenClaw.
const openclawStateDir = path.join(scratch, '.openclaw', 'state');
fs.mkdirSync(openclawStateDir, { recursive: true });
fs.writeFileSync(
  path.join(openclawStateDir, 'nexus_invocations.jsonl'),
  `${JSON.stringify({ ts: new Date().toISOString(), host: 'test-host', pid: 1, script: 'test', calls: 3 })}\n`,
);

const { start, stop } = await import('../src/server.mjs');

// validCode/deviceToken mirror what a real badge's AuthToken does (Nexus
// 2f45b023): a short-lived pairing code exchanged over POST /pair for the
// real, long-lived device token that gates POST /cards.
function fakeBadge({ validCode = '654321', deviceToken = 'test-token-123', haEntities = null } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ha-status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entities: (haEntities || []).map((id) => ({ id })) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/cards') {
      const token = req.headers['x-auth-token'];
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ token, cards: JSON.parse(body || '[]') });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/pair') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { code } = JSON.parse(body || '{}');
        if (code !== validCode) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('wrong code');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: deviceToken }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, received };
}

test('pair -> enable openclaw feed -> test -> badge receives a real POST /cards', async (t) => {
  const badge = fakeBadge();
  await new Promise((resolve) => badge.server.listen(0, '127.0.0.1', resolve));
  const badgePort = badge.server.address().port;

  const hostPort = 41731;
  await start(hostPort);
  t.after(async () => {
    await stop();
    await new Promise((resolve) => badge.server.close(resolve));
  });

  const base = `http://127.0.0.1:${hostPort}`;

  // 1. Config page loads and lists all 8 plugins (Nexus 281ee5a2 slice 4
  // added worldclock as the 8th).
  const state1 = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.equal(state1.feeds.length, 8);
  assert.equal(state1.badge.paired, false);

  // 2. Pair with the fake badge using its one-time 6-digit code.
  const pairRes = await fetch(`${base}/api/badge/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: badgePort, code: '654321' }),
  });
  assert.equal(pairRes.status, 200);
  assert.equal(badge.received.length, 0, 'pairing is a POST /pair exchange now, not a POST /cards probe');

  // 3. Enable the openclaw feed (no credential needed — real local data).
  const enableRes = await fetch(`${base}/api/feeds/openclaw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, intervalSeconds: 3600 }),
  });
  assert.equal(enableRes.status, 200);

  // 4. Trigger a manual test-now poll via the API — this is the actual
  // code path the "Test now" button in app.js calls.
  const testRes = await fetch(`${base}/api/feeds/openclaw/test`, { method: 'POST' });
  const testBody = await testRes.json();
  assert.equal(testBody.ok, true, JSON.stringify(testBody));

  // 5. The fake badge should now have received at least one real card push
  // (enabling the feed fires an immediate poll in addition to the explicit
  // "test now" call above, so >=1 rather than an exact count) carrying the
  // paired auth token.
  const pushes = badge.received.filter((r) => r.cards.length > 0);
  assert.ok(pushes.length >= 1);
  assert.equal(pushes.at(-1).token, 'test-token-123', 'push carries the token /pair handed back, not the code');
  assert.equal(pushes.at(-1).cards[0].id, 'openclaw-activity');

  // 6. Status now shows lastSuccess for this feed, not an error.
  const state2 = await fetch(`${base}/api/state`).then((r) => r.json());
  const feed = state2.feeds.find((f) => f.id === 'openclaw');
  assert.ok(feed.status.lastSuccess);
  assert.equal(feed.status.lastError, null);
});

test('a wrong pairing code fails pairing cleanly and never stores a token', async (t) => {
  const badge = fakeBadge({ validCode: '654321' });
  await new Promise((resolve) => badge.server.listen(0, '127.0.0.1', resolve));
  const badgePort = badge.server.address().port;

  const hostPort = 41732;
  await start(hostPort);
  const base = `http://127.0.0.1:${hostPort}`;
  t.after(async () => {
    await stop();
    await new Promise((resolve) => badge.server.close(resolve));
  });

  const res = await fetch(`${base}/api/badge/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: badgePort, code: '000000' }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /rejected that code/);
});

// Nexus 831d8e1a item 2: disabling a feed through the real /api/feeds/:id
// route a buyer's Feeds page actually calls has to evict that feed's
// cards right then — nothing else will ever notice afterward, since a
// disabled feed never polls again.
test('disabling a feed evicts its cards from the badge via the real /api/feeds/:id route', async (t) => {
  const badge = fakeBadge();
  await new Promise((resolve) => badge.server.listen(0, '127.0.0.1', resolve));
  const badgePort = badge.server.address().port;

  const hostPort = 41734;
  await start(hostPort);
  t.after(async () => {
    await stop();
    await new Promise((resolve) => badge.server.close(resolve));
  });
  const base = `http://127.0.0.1:${hostPort}`;

  await fetch(`${base}/api/badge/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: badgePort, code: '654321' }),
  });
  await fetch(`${base}/api/feeds/openclaw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, intervalSeconds: 3600 }),
  });
  await fetch(`${base}/api/feeds/openclaw/test`, { method: 'POST' });
  assert.ok(badge.received.some((r) => r.cards.some((c) => c.id === 'openclaw-activity')));

  badge.received.length = 0;
  const disableRes = await fetch(`${base}/api/feeds/openclaw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableRes.status, 200);

  const removals = badge.received.flatMap((r) => r.cards).filter((c) => c.remove);
  assert.ok(removals.some((c) => c.id === 'openclaw-activity'), `expected a remove push for openclaw-activity: ${JSON.stringify(badge.received)}`);
});

// Nexus 831d8e1a item 3: the host homeassistant plugin and the firmware's
// own HA-direct /ha-config can end up watching the same entity with no
// warning — that's the actual Bookshelf x3 / office-temp x2 root cause
// cited in the ticket. GET /api/state's haOverlap field is what the
// config page's warning banner reads, via findHaOverlap() in server.mjs.
test('GET /api/state reports haOverlap when the host HA plugin and the firmware /ha-config watch the same entity', async (t) => {
  const badge = fakeBadge({ haEntities: ['light.office_bookshelf', 'sensor.office_temp'] });
  await new Promise((resolve) => badge.server.listen(0, '127.0.0.1', resolve));
  const badgePort = badge.server.address().port;

  const hostPort = 41735;
  await start(hostPort);
  t.after(async () => {
    await stop();
    await new Promise((resolve) => badge.server.close(resolve));
  });
  const base = `http://127.0.0.1:${hostPort}`;

  await fetch(`${base}/api/badge/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: badgePort, code: '654321' }),
  });

  // Configure the homeassistant plugin's state entity to collide with one
  // of the firmware's own /ha-config entities, and leave the action entity
  // pointed at something the firmware doesn't watch.
  await fetch(`${base}/api/feeds/homeassistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { stateEntityId: 'light.office_bookshelf', actionEntityId: 'switch.not_on_firmware' } }),
  });

  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.deepEqual(state.haOverlap, ['light.office_bookshelf']);
});

test('GET /api/state reports no haOverlap when the host HA plugin entity is not also on the firmware', async (t) => {
  const badge = fakeBadge({ haEntities: ['sensor.office_temp'] });
  await new Promise((resolve) => badge.server.listen(0, '127.0.0.1', resolve));
  const badgePort = badge.server.address().port;

  const hostPort = 41736;
  await start(hostPort);
  t.after(async () => {
    await stop();
    await new Promise((resolve) => badge.server.close(resolve));
  });
  const base = `http://127.0.0.1:${hostPort}`;

  await fetch(`${base}/api/badge/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: badgePort, code: '654321' }),
  });
  await fetch(`${base}/api/feeds/homeassistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { stateEntityId: 'light.not_watched_by_firmware' } }),
  });

  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.deepEqual(state.haOverlap, []);
});

test('display order is a real, persisted per-feed setting — this is what the config page\'s up/down buttons drive', async (t) => {
  const hostPort = 41733;
  await start(hostPort);
  t.after(() => stop());
  const base = `http://127.0.0.1:${hostPort}`;

  // All feeds start at order 0 (config-store default) — assign distinct
  // values the way app.js's moveFeed() does after a swap: renumber every
  // feed 0..n-1 in the new order.
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  const ids = state.feeds.map((f) => f.id);
  const reordered = [ids[1], ids[0], ...ids.slice(2)]; // swap first two
  await Promise.all(reordered.map((id, i) => fetch(`${base}/api/feeds/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: i }),
  })));

  const state2 = await fetch(`${base}/api/state`).then((r) => r.json());
  const byId = Object.fromEntries(state2.feeds.map((f) => [f.id, f.config.order]));
  assert.equal(byId[reordered[0]], 0);
  assert.equal(byId[reordered[1]], 1);
  // Sorting by the persisted order (what app.js's renderFeeds does)
  // reproduces the swapped order, not the original plugin registration order.
  const sorted = [...state2.feeds].sort((a, b) => a.config.order - b.config.order).map((f) => f.id);
  assert.deepEqual(sorted, reordered);
});
