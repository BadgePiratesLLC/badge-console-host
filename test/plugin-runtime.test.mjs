import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-runtime-test-'));
setScratchHome(scratch);

const { PluginRuntime } = await import('../src/plugin-runtime.mjs');
const {
  updateConfig, resetConfigCacheForTests, loadConfig, getCardOverride,
} = await import('../src/config-store.mjs');

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

// --- Nexus 281ee5a2 slice 2: handleEdit() (layout editor edit-in-place) ---

test('handleEdit() throws on a card id no plugin has ever pushed', async () => {
  resetConfigCacheForTests();
  const runtime = new PluginRuntime([fakePlugin({ id: 'unrelated', cards: [] })]);
  await assert.rejects(() => runtime.handleEdit('never-pushed', { color: '#dc2626' }), /No known card owner/);
});

test('handleEdit() color override persists across the next poll, even though the plugin always emits the same fixed color', async () => {
  resetConfigCacheForTests();
  const feed = fakePlugin({ id: 'color-feed', cards: [{ id: 'c1', title: 'X', color: '#111111' }] });
  updateConfig((cfg) => { cfg.feeds['color-feed'] = { enabled: true, intervalSeconds: 60, order: 0, settings: {} }; });
  const runtime = new PluginRuntime([feed]);
  await runtime.runOnce('color-feed');
  await runtime.handleEdit('c1', { color: '#dc2626' });
  assert.deepEqual(getCardOverride('c1'), { color: '#dc2626' });
  const result = await runtime.runOnce('color-feed');
  assert.equal(result.cards[0].color, '#dc2626');
});

test('handleEdit() rejects a value edit when the owning plugin has no onEditValue()', async () => {
  resetConfigCacheForTests();
  const feed = fakePlugin({ id: 'no-edit-feed', cards: [{ id: 'c1', title: 'X' }] });
  const runtime = new PluginRuntime([feed]);
  await runtime.runOnce('no-edit-feed');
  await assert.rejects(() => runtime.handleEdit('c1', { value: 'new' }), /has no onEditValue/);
});

test('handleEdit() value edit persists new settings and rekeys cardOwner + color override to newCardId', async () => {
  resetConfigCacheForTests();
  let symbol = 'AAPL';
  const feed = {
    id: 'symbol-feed',
    label: 'symbol-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll() { return { cards: [{ id: `sym-${symbol.toLowerCase()}`, title: symbol }] }; },
    async onEditValue(ctx, cardId, newValue) {
      symbol = newValue.toUpperCase();
      return { settings: { ...ctx.settings, symbol }, newCardId: `sym-${symbol.toLowerCase()}` };
    },
  };
  updateConfig((cfg) => { cfg.feeds['symbol-feed'] = { enabled: true, intervalSeconds: 60, order: 0, settings: {} }; });
  const runtime = new PluginRuntime([feed]);
  await runtime.runOnce('symbol-feed');
  await runtime.handleEdit('sym-aapl', { value: 'tsla', color: '#16a34a' });
  await new Promise((resolve) => setTimeout(resolve, 10)); // post-edit refresh poll is fire-and-forget

  assert.equal(loadConfig().feeds['symbol-feed'].settings.symbol, 'TSLA');
  assert.equal(getCardOverride('sym-aapl'), null);
  assert.deepEqual(getCardOverride('sym-tsla'), { color: '#16a34a' });
  await assert.rejects(() => runtime.handleEdit('sym-aapl', { color: '#dc2626' }), /No known card owner/);
  await runtime.handleEdit('sym-tsla', { color: '#dc2626' }); // still routable under the new id
});

test('handleEdit() delete on a single-instance plugin (no onRemoveInstance) disables the feed and pushes a removal', async () => {
  resetConfigCacheForTests();
  const feed = fakePlugin({ id: 'single-feed', cards: [{ id: 'only-card', title: 'X' }] });
  updateConfig((cfg) => {
    cfg.feeds['single-feed'] = { enabled: true, intervalSeconds: 60, order: 0, settings: {} };
    cfg.badge = { host: '', port: 80, paired: false }; // no badge configured, so the removal push is skipped but the rest still runs
  });
  const runtime = new PluginRuntime([feed]);
  await runtime.runOnce('single-feed');
  await runtime.handleEdit('only-card', { deleteTile: true });
  assert.equal(loadConfig().feeds['single-feed'].enabled, false);
  assert.equal(runtime.cardOwner.has('only-card'), false);
  await assert.rejects(() => runtime.handleEdit('only-card', { color: '#dc2626' }), /No known card owner/);
});

test('handleEdit() delete on a multi-instance plugin removes just that instance, keeping the feed enabled', async () => {
  resetConfigCacheForTests();
  let symbols = ['AAPL', 'TSLA'];
  const feed = {
    id: 'multi-feed',
    label: 'multi-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll() { return { cards: symbols.map((s) => ({ id: `m-${s.toLowerCase()}`, title: s })) }; },
    async onRemoveInstance(ctx, cardId) {
      const sym = cardId.replace('m-', '').toUpperCase();
      symbols = symbols.filter((s) => s !== sym);
      return { settings: { ...ctx.settings, symbols: symbols.join(',') }, empty: symbols.length === 0 };
    },
  };
  updateConfig((cfg) => { cfg.feeds['multi-feed'] = { enabled: true, intervalSeconds: 60, order: 0, settings: {} }; });
  const runtime = new PluginRuntime([feed]);
  await runtime.runOnce('multi-feed');
  await runtime.handleEdit('m-aapl', { deleteTile: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loadConfig().feeds['multi-feed'].enabled, true); // one instance left — feed stays on
  assert.equal(loadConfig().feeds['multi-feed'].settings.symbols, 'TSLA');
});

test('handleEdit() delete on a multi-instance plugin disables the feed once the last instance is removed', async () => {
  resetConfigCacheForTests();
  let symbols = ['AAPL'];
  const feed = {
    id: 'last-feed',
    label: 'last-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll() { return { cards: symbols.map((s) => ({ id: `l-${s.toLowerCase()}`, title: s })) }; },
    async onRemoveInstance(ctx, cardId) {
      const sym = cardId.replace('l-', '').toUpperCase();
      symbols = symbols.filter((s) => s !== sym);
      return { settings: { ...ctx.settings, symbols: symbols.join(',') }, empty: symbols.length === 0 };
    },
  };
  updateConfig((cfg) => { cfg.feeds['last-feed'] = { enabled: true, intervalSeconds: 60, order: 0, settings: {} }; });
  const runtime = new PluginRuntime([feed]);
  await runtime.runOnce('last-feed');
  await runtime.handleEdit('l-aapl', { deleteTile: true });
  assert.equal(loadConfig().feeds['last-feed'].enabled, false);
});

test('a symbol dropped between polls is removed from lastCardIds/cardOwner and its color override is cleared (id-diffing)', async () => {
  resetConfigCacheForTests();
  let symbols = ['AAPL', 'TSLA'];
  const feed = {
    id: 'diff-feed',
    label: 'diff-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll() { return { cards: symbols.map((s) => ({ id: `d-${s.toLowerCase()}`, title: s })) }; },
  };
  // No badge host configured — this test is about the in-memory
  // bookkeeping _poll() updates on every run regardless of whether a push
  // actually goes out, not the network hop itself.
  const runtime = new PluginRuntime([feed]);
  await runtime.runOnce('diff-feed');
  assert.deepEqual([...runtime.lastCardIds.get('diff-feed')].sort(), ['d-aapl', 'd-tsla']);
  await runtime.handleEdit('d-aapl', { color: '#dc2626' });
  assert.deepEqual(getCardOverride('d-aapl'), { color: '#dc2626' });

  symbols = ['TSLA']; // simulates the symbol having been removed via the Feeds page instead
  await runtime.runOnce('diff-feed');
  assert.deepEqual([...runtime.lastCardIds.get('diff-feed')], ['d-tsla']);
  assert.equal(runtime.cardOwner.has('d-aapl'), false);
  assert.equal(getCardOverride('d-aapl'), null);
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
