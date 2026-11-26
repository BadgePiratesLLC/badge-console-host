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
// A plugin may also optionally export, for the layout editor's
// tap-to-edit panel (Nexus 281ee5a2 slice 2):
//   async onEditValue(ctx, cardId, newValue) -> { settings, newCardId? }
//     Called when a buyer edits that card's editValue field (see
//     CardSchema.md). Returns the feed's new settings object to persist;
//     newCardId is set only if the id changes as a result (e.g. stocks'
//     id is derived from the symbol). No onEditValue means that card's
//     value isn't editable from the layout page — color and delete still
//     work regardless.
//   async onRemoveInstance(ctx, cardId) -> { settings, empty? }
//     Only for plugins that can host more than one card (stocks today).
//     Removes just that instance; `empty: true` means none are left, and
//     the runtime disables the whole feed. A plugin without this is
//     single-instance by definition — deleting its one card disables the
//     feed the same way.

import { getSecret } from './credential-store.mjs';
import { pushCards } from './badge-client.mjs';
import {
  loadConfig, getFeedConfig, updateConfig,
  getCardOverride, setCardOverride, clearCardOverride, renameCardOverride,
} from './config-store.mjs';
import { log } from './logger.mjs';

const SERVICE = 'badge-console-host';

export class PluginRuntime {
  constructor(plugins, { actionPort } = {}) {
    this.plugins = new Map(plugins.map((p) => [p.id, p]));
    this.status = new Map(); // feedId -> { lastSuccess, lastError, nextPollAt, cardCount }
    this.timers = new Map();
    this.cardOwner = new Map(); // cardId -> pluginId, last plugin to push that id
    this.lastCardIds = new Map(); // pluginId -> Set<cardId> pushed on its last successful poll
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

    // Nexus 281ee5a2 slice 2: a plugin's poll() always emits the same
    // fixed color for a card (it owns no concept of a buyer override), so
    // a color chosen in the layout editor is re-applied here, after the
    // plugin runs and before the push, on every single poll — otherwise
    // the very next scheduled poll would silently overwrite it.
    for (const card of result.cards) {
      const override = card?.id ? getCardOverride(card.id) : null;
      if (override?.color) card.color = override.color;
    }

    // An id this plugin pushed last time but didn't produce this time
    // (e.g. a removed stock symbol) would otherwise just linger on the
    // badge forever, stale — tell it to drop those explicitly rather than
    // relying on the plugin to remember what it used to push.
    const newIds = new Set(result.cards.filter((c) => c?.id).map((c) => c.id));
    const previousIds = this.lastCardIds.get(plugin.id) || new Set();
    const removedIds = [...previousIds].filter((id) => !newIds.has(id));
    const toPush = removedIds.length
      ? [...result.cards, ...removedIds.map((id) => ({ id, remove: true }))]
      : result.cards;
    this.lastCardIds.set(plugin.id, newIds);
    for (const id of removedIds) clearCardOverride(id);

    if (cfg.badge.host) {
      try {
        await pushCards(cfg.badge.host, cfg.badge.port, toPush, { actionPort: this.actionPort });
      } catch (e) {
        const status = this.status.get(plugin.id);
        status.lastError = { message: `Got cards but push to badge failed: ${e.message}`, at: Date.now() };
        log.error(`[${plugin.id}] push to badge failed: ${e.message}`);
        return { ok: false, error: e.message };
      }
    }
    for (const card of result.cards) {
      if (card && card.id) this.cardOwner.set(card.id, plugin.id);
    }
    for (const id of removedIds) this.cardOwner.delete(id);

    const status = this.status.get(plugin.id);
    status.lastSuccess = Date.now();
    status.lastError = null;
    status.cardCount = result.cards.length;
    log.info(`[${plugin.id}] pushed ${result.cards.length} card(s).`);
    return { ok: true, cards: result.cards };
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

  // Shared by handleEdit()'s two "nothing left to show" cases: a
  // single-instance plugin's only card being deleted, or a multi-instance
  // plugin's last instance being removed. Disabling stops future polls,
  // but the badge still has the old card sitting there until told
  // otherwise — this pushes that removal explicitly since no further poll
  // is coming to do it via the normal id-diffing in _poll().
  async _disableFeedAndRemoveCard(pluginId, cardId) {
    updateConfig((cfg) => { cfg.feeds[pluginId].enabled = false; });
    clearCardOverride(cardId);
    this.cardOwner.delete(cardId);
    this.lastCardIds.set(pluginId, new Set());
    this.reschedule();
    const cfg = loadConfig();
    if (cfg.badge.host) {
      await pushCards(cfg.badge.host, cfg.badge.port, [{ id: cardId, remove: true }], { actionPort: this.actionPort });
    }
  }

  /**
   * Called by action-server.mjs's /edit route — the reverse channel the
   * badge-served layout editor uses to relay a tap-to-edit-panel submit
   * (Nexus 281ee5a2 slice 2: rename a tile's value, recolor it, or delete
   * it) back here. `change` is `{ value?, color?, deleteTile? }`, at
   * least one set. Throws on an unknown id or an edit kind the owning
   * plugin doesn't support — the caller turns that into an HTTP error
   * response, same pattern as handleAction().
   */
  async handleEdit(cardId, change) {
    const pluginId = this.cardOwner.get(cardId);
    if (!pluginId) throw new Error(`No known card owner for id "${cardId}".`);
    const plugin = this.plugins.get(pluginId);
    const feedCfg = getFeedConfig(pluginId, { intervalSeconds: plugin.defaultIntervalSeconds });
    const ctx = {
      settings: feedCfg.settings || {},
      getSecret: (account) => getSecret(SERVICE, account),
    };

    if (change.deleteTile) {
      if (typeof plugin.onRemoveInstance === 'function') {
        const result = await plugin.onRemoveInstance(ctx, cardId);
        updateConfig((cfg) => { cfg.feeds[pluginId].settings = result.settings; });
        if (result.empty) {
          await this._disableFeedAndRemoveCard(pluginId, cardId);
          log.info(`[${pluginId}] last instance removed — feed disabled.`);
          return;
        }
        // Falls through to the re-poll below; its own id-diffing (see
        // _poll()) notices this symbol is gone and pushes the removal
        // (and clears its color override) itself.
      } else {
        // Single-instance plugin: its one card IS the feed.
        await this._disableFeedAndRemoveCard(pluginId, cardId);
        log.info(`[${pluginId}] tile "${cardId}" deleted (feed disabled, single-instance).`);
        return;
      }
    } else {
      let effectiveCardId = cardId;
      if (change.value !== undefined) {
        if (typeof plugin.onEditValue !== 'function') {
          throw new Error(`Plugin "${pluginId}" has no onEditValue() — this card's value isn't editable.`);
        }
        const result = await plugin.onEditValue(ctx, cardId, change.value);
        updateConfig((cfg) => { cfg.feeds[pluginId].settings = result.settings; });
        if (result.newCardId && result.newCardId !== cardId) {
          renameCardOverride(cardId, result.newCardId);
          this.cardOwner.delete(cardId);
          this.cardOwner.set(result.newCardId, pluginId);
          effectiveCardId = result.newCardId;
        }
      }
      if (change.color) {
        setCardOverride(effectiveCardId, { color: change.color });
      }
    }

    log.info(`[${pluginId}] edit on "${cardId}" handled.`);
    this._poll(plugin, getFeedConfig(pluginId, { intervalSeconds: plugin.defaultIntervalSeconds }), loadConfig()).catch((e) => {
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
