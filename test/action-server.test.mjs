// The reverse channel a real badge calls into on a button-card tap
// (Nexus 7c9c1a15, scope addition 2026-11-21). Exercises the auth gate
// and the routing to PluginRuntime.handleAction() without a physical
// badge — see server-e2e.test.mjs for the forward (host -> badge) half
// of this same round trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-action-test-'));
setScratchHome(scratch);

const { createActionServer } = await import('../src/action-server.mjs');
const { setBadgeToken } = await import('../src/badge-client.mjs');

function fakeRuntime(handler) {
  return { handleAction: handler };
}

async function post(server, { headers = {}, body, path = '/action' } = {}) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a missing X-Auth-Token is refused with 401 and never reaches the runtime', async () => {
  await setBadgeToken('real-token');
  let called = false;
  const server = createActionServer(fakeRuntime(async () => { called = true; }));
  const res = await post(server, { body: { id: 'btn-1' } });
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('a wrong X-Auth-Token is refused with 401', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntime(async () => {}));
  const res = await post(server, { headers: { 'X-Auth-Token': 'wrong' }, body: { id: 'btn-1' } });
  assert.equal(res.status, 401);
});

test('the right token with a known card id calls runtime.handleAction and returns 200', async () => {
  await setBadgeToken('real-token');
  const calls = [];
  const server = createActionServer(fakeRuntime(async (id) => { calls.push(id); }));
  const res = await post(server, { headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'btn-1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['btn-1']);
});

test('an unknown card id surfaces as 404, not a generic 500', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntime(async () => { throw new Error('No known card owner for id "x".'); }));
  const res = await post(server, { headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'x' } });
  assert.equal(res.status, 404);
});

test('a plugin whose onAction() throws for another reason surfaces as 502', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntime(async () => { throw new Error('Home Assistant returned HTTP 500'); }));
  const res = await post(server, { headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'btn-1' } });
  assert.equal(res.status, 502);
});

test('a body with no id is rejected with 400 once auth has passed', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntime(async () => {}));
  const res = await post(server, { headers: { 'X-Auth-Token': 'real-token' }, body: {} });
  assert.equal(res.status, 400);
});

// Nexus 281ee5a2 slice 2/3: POST /edit is the badge-served layout
// editor's tap-to-edit/recolor/delete relay, same auth gate as /action —
// before this route existed, the firmware's /tile-edit forward (shipped
// with slice 2) 404'd here since this listener only ever answered
// /action.

function fakeEditRuntime(handler) {
  return { handleAction: async () => { throw new Error('not used in these tests'); }, handleEdit: handler };
}

test('an /edit request with a missing X-Auth-Token is refused with 401 and never reaches the runtime', async () => {
  await setBadgeToken('real-token');
  let called = false;
  const server = createActionServer(fakeEditRuntime(async () => { called = true; }));
  const res = await post(server, { path: '/edit', body: { id: 'card-1', color: '#abcdef' } });
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('the right token with a known card id calls runtime.handleEdit with the full body and returns 200', async () => {
  await setBadgeToken('real-token');
  const calls = [];
  const server = createActionServer(fakeEditRuntime(async (id, edit) => { calls.push([id, edit]); }));
  const res = await post(server, {
    path: '/edit',
    headers: { 'X-Auth-Token': 'real-token' },
    body: { id: 'card-1', color: '#abcdef' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['card-1', { id: 'card-1', color: '#abcdef' }]]);
});

test('an /edit on an unknown card id surfaces as 404', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeEditRuntime(async () => { throw new Error('No known card owner for id "x".'); }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'x', color: '#000000' } });
  assert.equal(res.status, 404);
});

test('an /edit value edit the owning plugin does not support surfaces as 404, not 502', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeEditRuntime(async () => { throw new Error('Plugin "weather" doesn\'t support editing card "x"\'s value yet.'); }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'x', value: 'y' } });
  assert.equal(res.status, 404);
});

test('an /edit body with no id is rejected with 400 once auth has passed', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeEditRuntime(async () => {}));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { color: '#000000' } });
  assert.equal(res.status, 400);
});

// Nexus 281ee5a2 slice 3: POST /move is the badge-served layout editor's
// drag/reorder relay. No top-level `id` — carries a "moves" array of
// {id, order} pairs instead, same reverse channel as /edit.

function fakeMoveRuntime(handler) {
  return { handleAction: async () => { throw new Error('not used in these tests'); }, handleMove: handler };
}

test('a /move request with a missing X-Auth-Token is refused with 401 and never reaches the runtime', async () => {
  await setBadgeToken('real-token');
  let called = false;
  const server = createActionServer(fakeMoveRuntime(async () => { called = true; }));
  const res = await post(server, { path: '/move', body: { moves: [{ id: 'card-1', order: 0 }] } });
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('the right token with a moves array calls runtime.handleMove with the array and returns 200', async () => {
  await setBadgeToken('real-token');
  const calls = [];
  const server = createActionServer(fakeMoveRuntime(async (moves) => { calls.push(moves); }));
  const res = await post(server, {
    path: '/move',
    headers: { 'X-Auth-Token': 'real-token' },
    body: { moves: [{ id: 'card-1', order: 1 }, { id: 'card-2', order: 0 }] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [[{ id: 'card-1', order: 1 }, { id: 'card-2', order: 0 }]]);
});

test('a /move with an unknown card id surfaces as 404', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeMoveRuntime(async () => { throw new Error('No known card owner for id "x".'); }));
  const res = await post(server, { path: '/move', headers: { 'X-Auth-Token': 'real-token' }, body: { moves: [{ id: 'x', order: 0 }] } });
  assert.equal(res.status, 404);
});

test('a /move body with no moves array is rejected with 400 once auth has passed', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeMoveRuntime(async () => {}));
  const res = await post(server, { path: '/move', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'card-1' } });
  assert.equal(res.status, 400);
});

test('an unrouted path still 404s without reaching the runtime', async () => {
  await setBadgeToken('real-token');
  let called = false;
  const server = createActionServer(fakeEditRuntime(async () => { called = true; }));
  const res = await post(server, { path: '/nope', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'x' } });
  assert.equal(res.status, 404);
  assert.equal(called, false);
});

// Nexus 281ee5a2 slice 4: POST /add is the badge-served layout editor's
// "+ Add" empty-slot relay. No top-level `id` (the card doesn't exist
// yet) — carries {pluginId, value} instead, same reverse channel as
// /edit and /move.

function fakeAddRuntime(handler) {
  return { handleAction: async () => { throw new Error('not used in these tests'); }, handleAdd: handler };
}

test('an /add request with a missing X-Auth-Token is refused with 401 and never reaches the runtime', async () => {
  await setBadgeToken('real-token');
  let called = false;
  const server = createActionServer(fakeAddRuntime(async () => { called = true; }));
  const res = await post(server, { path: '/add', body: { pluginId: 'stocks', value: 'TSLA' } });
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test('the right token with a pluginId and value calls runtime.handleAdd and returns 200', async () => {
  await setBadgeToken('real-token');
  const calls = [];
  const server = createActionServer(fakeAddRuntime(async (pluginId, value) => { calls.push([pluginId, value]); }));
  const res = await post(server, {
    path: '/add',
    headers: { 'X-Auth-Token': 'real-token' },
    body: { pluginId: 'stocks', value: 'TSLA' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['stocks', 'TSLA']]);
});

test('an /add for an unknown plugin surfaces as 404', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeAddRuntime(async () => { throw new Error('No such plugin: "x".'); }));
  const res = await post(server, { path: '/add', headers: { 'X-Auth-Token': 'real-token' }, body: { pluginId: 'x', value: 'y' } });
  assert.equal(res.status, 404);
});

test('an /add for a plugin that does not support adding surfaces as 404', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeAddRuntime(async () => { throw new Error('Plugin "weather" doesn\'t support adding cards yet.'); }));
  const res = await post(server, { path: '/add', headers: { 'X-Auth-Token': 'real-token' }, body: { pluginId: 'weather', value: 'y' } });
  assert.equal(res.status, 404);
});

test('an /add rejected by the plugin itself (e.g. max reached) surfaces as 400, not 502', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeAddRuntime(async () => { throw new Error('Already have 3 symbols (max) — remove one first.'); }));
  const res = await post(server, { path: '/add', headers: { 'X-Auth-Token': 'real-token' }, body: { pluginId: 'stocks', value: 'y' } });
  assert.equal(res.status, 400);
});

test('an /add body with no pluginId or value is rejected with 400 once auth has passed', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeAddRuntime(async () => {}));
  const res1 = await post(server, { path: '/add', headers: { 'X-Auth-Token': 'real-token' }, body: { value: 'y' } });
  assert.equal(res1.status, 400);
  const res2 = await post(server, { path: '/add', headers: { 'X-Auth-Token': 'real-token' }, body: { pluginId: 'stocks' } });
  assert.equal(res2.status, 400);
});
