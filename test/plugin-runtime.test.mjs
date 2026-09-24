import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-runtime-test-'));
setScratchHome(scratch);

const { PluginRuntime } = await import('../src/plugin-runtime.mjs');
const { updateConfig, resetConfigCacheForTests } = await import('../src/config-store.mjs');

function fakePlugin({ id, cards, shouldThrow }) {
  return {
    id,
    label: id,
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    needsCredentials: [],
    settingsSchema: [],
    async poll() {
      if (shouldThrow) throw new Error(`${id} deliberately failed`);
      return { cards };
    },
  };
}

test('a throwing plugin never produces a push and reports the error, not a zero', async () => {
  resetConfigCacheForTests();
  const failing = fakePlugin({ id: 'failing-feed', shouldThrow: true });
  const runtime = new PluginRuntime([failing]);
  // No badge configured, so pushCards is never reached even on success —
  // this test is purely about the contract: throw in, no cards out, error surfaced.
  const result = await runtime.runOnce('failing-feed');
  assert.equal(result.ok, false);
  assert.match(result.error, /deliberately failed/);
  const status = runtime.getStatus()['failing-feed'];
  assert.ok(status.lastError);
  assert.equal(status.lastSuccess, null);
  assert.equal(status.cardCount, 0);
});

test('a succeeding plugin reports success and card count', async () => {
  resetConfigCacheForTests();
  const ok = fakePlugin({ id: 'ok-feed', cards: [{ id: 'c1', title: 'X' }, { id: 'c2', title: 'Y' }] });
  const runtime = new PluginRuntime([ok]);
  const result = await runtime.runOnce('ok-feed');
  assert.equal(result.ok, true);
  assert.equal(result.cards.length, 2);
  const status = runtime.getStatus()['ok-feed'];
  assert.equal(status.lastError, null);
  assert.ok(status.lastSuccess);
  assert.equal(status.cardCount, 2);
});

test('a plugin that violates the contract (no cards array) is treated as an error, not silently accepted', async () => {
  resetConfigCacheForTests();
  const malformed = {
    id: 'malformed-feed',
    label: 'malformed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    needsCredentials: [],
    settingsSchema: [],
    async poll() { return { notCards: true }; },
  };
  const runtime = new PluginRuntime([malformed]);
  const result = await runtime.runOnce('malformed-feed');
  assert.equal(result.ok, false);
  assert.match(result.error, /no cards array/);
});

test('reschedule only arms timers for enabled feeds, respecting minIntervalSeconds', async () => {
  resetConfigCacheForTests();
  const feed = fakePlugin({ id: 'scheduled-feed', cards: [] });
  const runtime = new PluginRuntime([feed]);
  updateConfig((cfg) => {
    cfg.feeds['scheduled-feed'] = { enabled: true, intervalSeconds: 1, order: 0, settings: {} };
  });
  runtime.start();
  assert.equal(runtime.timers.size, 1);
  runtime.stop();
  assert.equal(runtime.timers.size, 0);
});
