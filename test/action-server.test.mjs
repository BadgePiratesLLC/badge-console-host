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

// --- Nexus 281ee5a2 slice 2: POST /edit (layout editor edit-in-place) ---

function fakeRuntimeWithEdit(handler) {
  return { handleAction: async () => {}, handleEdit: handler };
}

test('/edit requires the same X-Auth-Token as /action', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntimeWithEdit(async () => {}));
  const res = await post(server, { path: '/edit', body: { id: 'c1', color: '#dc2626' } });
  assert.equal(res.status, 401);
});

test('/edit with none of value/color/delete present is rejected with 400 before reaching the runtime', async () => {
  await setBadgeToken('real-token');
  let called = false;
  const server = createActionServer(fakeRuntimeWithEdit(async () => { called = true; }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'c1' } });
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('/edit routes {id, value} to runtime.handleEdit as { value }', async () => {
  await setBadgeToken('real-token');
  const calls = [];
  const server = createActionServer(fakeRuntimeWithEdit(async (id, change) => { calls.push([id, change]); }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'c1', value: 'TSLA' } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['c1', { value: 'TSLA' }]]);
});

test('/edit routes {id, color} to runtime.handleEdit as { color }', async () => {
  await setBadgeToken('real-token');
  const calls = [];
  const server = createActionServer(fakeRuntimeWithEdit(async (id, change) => { calls.push([id, change]); }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'c1', color: '#dc2626' } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['c1', { color: '#dc2626' }]]);
});

test('/edit routes {id, delete: true} to runtime.handleEdit as { deleteTile: true }', async () => {
  await setBadgeToken('real-token');
  const calls = [];
  const server = createActionServer(fakeRuntimeWithEdit(async (id, change) => { calls.push([id, change]); }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'c1', delete: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['c1', { deleteTile: true }]]);
});

test('/edit on an unknown card id surfaces as 404', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntimeWithEdit(async () => { throw new Error('No known card owner for id "x".'); }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'x', color: '#dc2626' } });
  assert.equal(res.status, 404);
});

test('/edit when the plugin rejects the edit for another reason surfaces as 502', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntimeWithEdit(async () => { throw new Error('Already tracking "TSLA" in another tile.'); }));
  const res = await post(server, { path: '/edit', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'c1', value: 'TSLA' } });
  assert.equal(res.status, 502);
});

test('/action and /edit stay independent — a runtime with handleAction only still answers /action (no /edit support)', async () => {
  await setBadgeToken('real-token');
  const server = createActionServer(fakeRuntime(async (id) => {}));
  const res = await post(server, { path: '/action', headers: { 'X-Auth-Token': 'real-token' }, body: { id: 'btn-1' } });
  assert.equal(res.status, 200);
});
