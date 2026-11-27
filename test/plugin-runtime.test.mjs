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
    credentialsSchema: [],
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
    credentialsSchema: [],
    settingsSchema: [],
    async poll() { return { notCards: true }; },
  };
  const runtime = new PluginRuntime([malformed]);
  const result = await runtime.runOnce('malformed-feed');
  assert.equal(result.ok, false);
  assert.match(result.error, /no cards array/);
});

test('handleAction() routes a tapped card id to the plugin that last pushed it', async () => {
  resetConfigCacheForTests();
  const calls = [];
  const button = {
    id: 'button-feed',
    label: 'button-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll() { return { cards: [{ id: 'btn-1', type: 'button' }] }; },
    async onAction(ctx, cardId) { calls.push(cardId); },
  };
  const runtime = new PluginRuntime([button]);
  await runtime.runOnce('button-feed'); // populates cardOwner as a side effect of a successful poll
  await runtime.handleAction('btn-1');
  assert.deepEqual(calls, ['btn-1']);
});

test('handleAction() pushes a fresh poll right after a successful action, not waiting for the next scheduled one', async () => {
  resetConfigCacheForTests();
  let pollCount = 0;
  const button = {
    id: 'ha-like-feed',
    label: 'ha-like-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll() {
      pollCount++;
      return { cards: [{ id: 'btn-1', type: 'button', value: pollCount > 1 ? 'ON' : 'OFF' }] };
    },
    async onAction() {},
  };
  const runtime = new PluginRuntime([button]);
  await runtime.runOnce('ha-like-feed'); // first poll, populates cardOwner
  assert.equal(pollCount, 1);
  await runtime.handleAction('btn-1');
  // The refresh poll is fire-and-forget (handleAction must not block the
  // badge's HTTP response on it) — give its microtask a turn to settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pollCount, 2);
});

test('handleAction() throws on a card id no plugin has ever pushed', async () => {
  resetConfigCacheForTests();
  const runtime = new PluginRuntime([fakePlugin({ id: 'unrelated', cards: [] })]);
  await assert.rejects(() => runtime.handleAction('never-pushed'), /No known card owner/);
});

test('handleAction() throws if the owning plugin has no onAction()', async () => {
  resetConfigCacheForTests();
  const infoOnly = fakePlugin({ id: 'info-feed', cards: [{ id: 'info-1' }] });
  const runtime = new PluginRuntime([infoOnly]);
  await runtime.runOnce('info-feed');
  await assert.rejects(() => runtime.handleAction('info-1'), /has no onAction/);
});

// Nexus 281ee5a2 slice 2/3: handleEdit() is the second half of the
// layout editor's reverse channel (see action-server.mjs's POST /edit) —
// this was the gap that made every edit on the badge's own /layout page
// 404 back to it, since the host had no /edit route at all until now.

test('handleEdit() applies a color override generically, even for a plugin with no editCardValue', async () => {
  resetConfigCacheForTests();
  const plain = fakePlugin({ id: 'plain-feed', cards: [{ id: 'plain-1', title: 'X', color: '#111111' }] });
  const runtime = new PluginRuntime([plain]);
  await runtime.runOnce('plain-feed');
  await runtime.handleEdit('plain-1', { color: '#abcdef' });
  const result = await runtime.runOnce('plain-feed');
  assert.equal(result.cards[0].color, '#abcdef');
});

test('handleEdit() hides a card generically (delete) when the plugin has no removeCardValue', async () => {
  resetConfigCacheForTests();
  const plain = fakePlugin({ id: 'plain-feed-2', cards: [{ id: 'plain-2', title: 'X' }] });
  const runtime = new PluginRuntime([plain]);
  await runtime.runOnce('plain-feed-2');
  await runtime.handleEdit('plain-2', { delete: true });
  const result = await runtime.runOnce('plain-feed-2');
  assert.deepEqual(result.cards, []);
});

test('handleEdit() throws when a value edit is requested on a plugin with no editCardValue', async () => {
  resetConfigCacheForTests();
  const plain = fakePlugin({ id: 'plain-feed-3', cards: [{ id: 'plain-3', title: 'X' }] });
  const runtime = new PluginRuntime([plain]);
  await runtime.runOnce('plain-feed-3');
  await assert.rejects(() => runtime.handleEdit('plain-3', { value: 'new' }), /doesn't support editing/);
});

test('handleEdit() routes a value edit through the owning plugin\'s editCardValue and persists it', async () => {
  resetConfigCacheForTests();
  const calls = [];
  const editable = {
    id: 'editable-feed',
    label: 'editable-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll(ctx) { return { cards: [{ id: 'ed-1', title: ctx.settings.symbol || 'AAPL' }] }; },
    editCardValue(settings, cardId, newValue) {
      calls.push([cardId, newValue]);
      if (cardId !== 'ed-1') return null;
      return { ...settings, symbol: newValue };
    },
  };
  const runtime = new PluginRuntime([editable]);
  await runtime.runOnce('editable-feed');
  await runtime.handleEdit('ed-1', { value: 'TSLA' });
  assert.deepEqual(calls, [['ed-1', 'TSLA']]);
  const result = await runtime.runOnce('editable-feed');
  assert.equal(result.cards[0].title, 'TSLA');
});

test('handleEdit() routes delete through removeCardValue when the plugin defines it', async () => {
  resetConfigCacheForTests();
  const removable = {
    id: 'removable-feed',
    label: 'removable-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll(ctx) {
      return { cards: (ctx.settings.symbols || 'A,B').split(',').map((s) => ({ id: `rm-${s.toLowerCase()}`, title: s })) };
    },
    removeCardValue(settings, cardId) {
      const symbols = String(settings.symbols || 'A,B').split(',');
      const idx = symbols.findIndex((s) => `rm-${s.toLowerCase()}` === cardId);
      if (idx < 0) return null;
      return { ...settings, symbols: symbols.filter((_, j) => j !== idx).join(',') };
    },
  };
  const runtime = new PluginRuntime([removable]);
  await runtime.runOnce('removable-feed');
  await runtime.handleEdit('rm-b', { delete: true });
  const result = await runtime.runOnce('removable-feed');
  assert.deepEqual(result.cards.map((c) => c.id), ['rm-a']);
});

test('handleEdit() throws on a card id no plugin has ever pushed', async () => {
  resetConfigCacheForTests();
  const runtime = new PluginRuntime([fakePlugin({ id: 'unrelated-2', cards: [] })]);
  await assert.rejects(() => runtime.handleEdit('never-pushed', { color: '#000000' }), /No known card owner/);
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
