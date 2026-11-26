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
// shape as poll(). Throwing here just logs; there is no card to update
// since a button tap isn't itself new data.

import { getSecret } from './credential-store.mjs';
import { pushCards } from './badge-client.mjs';
import { loadConfig, getFeedConfig } from './config-store.mjs';
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
    if (cfg.badge.host) {
      try {
        await pushCards(cfg.badge.host, cfg.badge.port, result.cards, { actionPort: this.actionPort });
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
