// The plugin contract and the scheduler that enforces it.
//
// Contract (see README.md "Writing a plugin" for the full version a new
// feed author reads):
//   export const id, label, defaultIntervalSeconds, credentialsSchema
//     credentialsSchema: [{ account, label, helpUrl?, required }, ...]
//     — `required: false` means the feed works keylessly and the account
//     is an opt-in upgrade (e.g. stocks' Finnhub key); the Feeds page
//     only shows a "needs key" pill for a missing `required: true` one.
//   export async function poll(ctx) -> { cards: [Card, ...] }
//   ctx = { settings, getSecret(account), setStatusHint(text) }
//
// A plugin either resolves with cards or throws/rejects. There is no third
// option — "return nothing quietly" is not a supported outcome, because a
// silently-empty push and a healthy empty feed would be indistinguishable
// to the buyer. Throwing is how a plugin says "I have nothing new and here
// is why"; the runtime never pushes on a throw and never invents a zero in
// the plugin's place.
//
// A plugin may optionally export `async onAction(ctx, cardId)`, called
// when the badge reports a tap on one of that plugin's `type: 'button'`
// cards (see action-server.mjs — the badge calls back over the LAN, the
// runtime routes by which plugin last pushed that card id). Same ctx
// shape as poll(). Throwing here just logs and skips the refresh below.
// On success, handleAction() re-runs that plugin's own poll() and pushes
// its cards immediately (Nexus ba0be49a) rather than waiting for its
// normal interval — a tapped light's state card should flip right away,
// not up to a minute later.
//
// A plugin may also optionally export `editCardValue(settings, cardId,
// newValue)` and `removeCardValue(settings, cardId)` — the layout
// editor's (Nexus 281ee5a2) tap-to-edit-in-place and delete, relayed from
// the badge-served /layout page through action-server.mjs's POST /edit.
// Each takes the plugin's own current settings object and this plugin's
// own card-id convention (e.g. stocks' `stocks-<symbol>`) and returns a
// NEW settings object, or null if cardId isn't one of this plugin's
// editable slots. A plugin that defines neither only supports the two
// generic, id-keyed overrides every card gets for free regardless of
// plugin — color (cfg.cardOverrides[id].color) and delete-as-hide
// (cfg.cardOverrides[id].hidden) — applied in _poll() below, after
// poll() returns and before the push.

import { getSecret } from './credential-store.mjs';
import { pushCards } from './badge-client.mjs';
import { loadConfig, getFeedConfig, updateConfig } from './config-store.mjs';
import { log } from './logger.mjs';

const SERVICE = 'badge-console-host';

export class PluginRuntime {
  constructor(plugins, { actionPort } = {}) {
    this.plugins = new Map(plugins.map((p) => [p.id, p]));
    this.status = new Map(); // feedId -> { lastSuccess, lastError, nextPollAt, cardCount }
    this.timers = new Map();
    this.cardOwner = new Map(); // cardId -> pluginId, last plugin to push that id
    this.actionPort = actionPort; // told to the badge on every push, see action-server.mjs
    for (const p of plugins) {
      this.status.set(p.id, { lastSuccess: null, lastError: null, nextPollAt: null, cardCount: 0 });
    }
  }

  listPlugins() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description || '',
      defaultIntervalSeconds: p.defaultIntervalSeconds,
      minIntervalSeconds: p.minIntervalSeconds || 1,
      credentialsSchema: p.credentialsSchema || [],
      settingsSchema: p.settingsSchema || [],
    }));
  }

  getStatus() {
    const out = {};
    for (const [id, s] of this.status.entries()) out[id] = s;
    return out;
  }

  /** Run a single plugin once, outside the schedule, for a "test feed" button. */
  async runOnce(feedId) {
    const plugin = this.plugins.get(feedId);
    if (!plugin) throw new Error(`No such plugin: ${feedId}`);
    const cfg = loadConfig();
    const feedCfg = getFeedConfig(feedId, { intervalSeconds: plugin.defaultIntervalSeconds });
    return this._poll(plugin, feedCfg, cfg);
  }

  async _poll(plugin, feedCfg, cfg) {
    const ctx = {
      settings: feedCfg.settings || {},
      getSecret: (account) => getSecret(SERVICE, account),
    };
    let result;
    let timeoutHandle;
    try {
      result = await Promise.race([
        plugin.poll(ctx),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Plugin poll timed out after 15s')), 15000);
        }),
      ]);
    } catch (e) {
      clearTimeout(timeoutHandle);
      const status = this.status.get(plugin.id);
      status.lastError = { message: e.message, at: Date.now() };
      log.error(`[${plugin.id}] poll failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
    clearTimeout(timeoutHandle);
    if (!result || !Array.isArray(result.cards)) {
      const status = this.status.get(plugin.id);
      status.lastError = { message: 'Plugin returned no cards array (contract violation).', at: Date.now() };
      log.error(`[${plugin.id}] contract violation: poll() resolved without a cards array.`);
      return { ok: false, error: 'Plugin returned no cards array.' };
    }
    // Nexus 281ee5a2: the layout editor's generic recolor/delete overrides
    // apply here, after the plugin's own poll() and before anything is
    // pushed or counted — every plugin gets a working "recolor"/"delete
    // tile" even if it has no editCardValue/removeCardValue of its own
    // (those two only cover *value* edits, which are inherently plugin-
    // specific). Tracked by card id, not by plugin, since a plugin's own
    // card-id convention (e.g. stocks' `stocks-aapl`) is already the
    // stable key the editor's tap-to-edit uses.
    const overrides = cfg.cardOverrides || {};
    const cards = result.cards
      .filter((c) => !(c && c.id && overrides[c.id]?.hidden))
      .map((c) => (c && c.id && overrides[c.id]?.color ? { ...c, color: overrides[c.id].color } : c));

    if (cfg.badge.host) {
      try {
        await pushCards(cfg.badge.host, cfg.badge.port, cards, { actionPort: this.actionPort });
      } catch (e) {
        const status = this.status.get(plugin.id);
        status.lastError = { message: `Got cards but push to badge failed: ${e.message}`, at: Date.now() };
        log.error(`[${plugin.id}] push to badge failed: ${e.message}`);
        return { ok: false, error: e.message };
      }
    }
    // Ownership is tracked off the plugin's RAW output, not the filtered
    // `cards` — a hidden card still needs a known owner so a future
    // "un-hide" has somewhere to route to.
    for (const card of result.cards) {
      if (card && card.id) this.cardOwner.set(card.id, plugin.id);
    }

    const status = this.status.get(plugin.id);
    status.lastSuccess = Date.now();
    status.lastError = null;
    status.cardCount = cards.length;
    log.info(`[${plugin.id}] pushed ${cards.length} card(s).`);
    return { ok: true, cards };
  }

  /**
   * Called by action-server.mjs when the badge reports a tap on a
   * `type: 'button'` card. Routes to whichever plugin last pushed that
   * card id and calls its onAction(ctx, cardId), if it defines one.
   * Throws if the id is unknown or its owning plugin doesn't support
   * actions — the caller (action-server.mjs) turns that into an HTTP
   * error response.
   */
  async handleAction(cardId) {
    const pluginId = this.cardOwner.get(cardId);
    if (!pluginId) throw new Error(`No known card owner for id "${cardId}".`);
    const plugin = this.plugins.get(pluginId);
    if (!plugin || typeof plugin.onAction !== 'function') {
      throw new Error(`Plugin "${pluginId}" owns card "${cardId}" but has no onAction().`);
    }
    const feedCfg = getFeedConfig(pluginId, { intervalSeconds: plugin.defaultIntervalSeconds });
    const ctx = {
      settings: feedCfg.settings || {},
      getSecret: (account) => getSecret(SERVICE, account),
    };
    await plugin.onAction(ctx, cardId);
    log.info(`[${pluginId}] action "${cardId}" handled.`);

    // Re-poll and push right away rather than leaving the tile on its
    // pre-tap value until the plugin's own schedule comes around (up to
    // 60s for Home Assistant) — Nexus ba0be49a: a tap should flip the
    // tile's state within about a second. Fire-and-forget: the badge is
    // waiting on this HTTP response for its own tap feedback, and that
    // round trip shouldn't block on a second poll+push cycle.
    this._poll(plugin, feedCfg, loadConfig()).catch((e) => {
      log.error(`[${pluginId}] post-action refresh poll failed: ${e.message}`);
    });
  }

  /**
   * Called by action-server.mjs's POST /edit — the badge-served layout
   * editor's (Nexus 281ee5a2) tap-to-edit-in-place, recolor, and delete,
   * relayed from the browser through the badge's own /tile-edit handler
   * and back here the same way a button tap reaches handleAction(). edit
   * is the browser's raw body minus `id`: `{ value?, color?, delete? }`.
   * Throws on an unknown id or an unsupported value edit — the caller
   * turns that into the HTTP status the badge's toast shows the buyer.
   */
  async handleEdit(cardId, edit) {
    const pluginId = this.cardOwner.get(cardId);
    if (!pluginId) throw new Error(`No known card owner for id "${cardId}".`);
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Plugin "${pluginId}" owns card "${cardId}" but is no longer loaded.`);

    if (edit.delete) {
      if (typeof plugin.removeCardValue === 'function') {
        const feedCfg = getFeedConfig(pluginId, { intervalSeconds: plugin.defaultIntervalSeconds });
        const nextSettings = plugin.removeCardValue(feedCfg.settings || {}, cardId);
        if (!nextSettings) throw new Error(`Plugin "${pluginId}" has no editable slot for card "${cardId}".`);
        updateConfig((cfg) => { cfg.feeds[pluginId].settings = nextSettings; });
      } else {
        updateConfig((cfg) => {
          cfg.cardOverrides = cfg.cardOverrides || {};
          cfg.cardOverrides[cardId] = { ...cfg.cardOverrides[cardId], hidden: true };
        });
      }
    } else {
      if (edit.value !== undefined) {
        if (typeof plugin.editCardValue !== 'function') {
          throw new Error(`Plugin "${pluginId}" doesn't support editing card "${cardId}"'s value yet.`);
        }
        const feedCfg = getFeedConfig(pluginId, { intervalSeconds: plugin.defaultIntervalSeconds });
        const nextSettings = plugin.editCardValue(feedCfg.settings || {}, cardId, edit.value);
        if (!nextSettings) throw new Error(`Plugin "${pluginId}" has no editable slot for card "${cardId}".`);
        updateConfig((cfg) => { cfg.feeds[pluginId].settings = nextSettings; });
      }
      if (edit.color !== undefined) {
        updateConfig((cfg) => {
          cfg.cardOverrides = cfg.cardOverrides || {};
          cfg.cardOverrides[cardId] = { ...cfg.cardOverrides[cardId], color: edit.color };
        });
      }
    }

    log.info(`[${pluginId}] edit "${cardId}" handled (${JSON.stringify(edit)}).`);

    // Same fire-and-forget immediate refresh as handleAction() — the
    // layout page's own 2s /cards poll should show the edit without
    // waiting for this plugin's normal schedule.
    const feedCfg = getFeedConfig(pluginId, { intervalSeconds: plugin.defaultIntervalSeconds });
    this._poll(plugin, feedCfg, loadConfig()).catch((e) => {
      log.error(`[${pluginId}] post-edit refresh poll failed: ${e.message}`);
    });
  }

  /** Start the recurring per-feed poll loop, one independent interval per enabled feed. */
  start() {
    this.reschedule();
  }

  reschedule() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    const cfg = loadConfig();
    for (const plugin of this.plugins.values()) {
      const feedCfg = getFeedConfig(plugin.id, { intervalSeconds: plugin.defaultIntervalSeconds });
      if (!feedCfg.enabled) continue;
      const intervalMs = Math.max(plugin.minIntervalSeconds || 1, feedCfg.intervalSeconds) * 1000;
      const tick = async () => {
        const status = this.status.get(plugin.id);
        status.nextPollAt = Date.now() + intervalMs;
        await this._poll(plugin, feedCfg, loadConfig());
      };
      tick(); // fire once immediately on (re)schedule rather than waiting a full interval
      this.timers.set(plugin.id, setInterval(tick, intervalMs));
    }
  }

  stop() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}
