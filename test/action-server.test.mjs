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

async function post(server, { headers = {}, body } = {}) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/action`, {
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
