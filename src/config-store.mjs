// Non-secret settings only. Credential values never pass through here —
// see credential-store.mjs. This file just remembers *which* account names
// a feed needs, plus the buyer-facing knobs (on/off, interval, order,
// per-feed settings like a stock symbol or a team id).

import fs from 'node:fs';
import { HOME_DIR, CONFIG_PATH } from './paths.mjs';

const DEFAULT_CONFIG = {
  badge: { host: '', port: 80, paired: false },
  feeds: {}, // feedId -> { enabled, intervalSeconds, order, settings }
  // cardId -> { color } — Nexus 281ee5a2 slice 2 (layout editor
  // edit-in-place). A plugin's own poll() always sets a fixed color per
  // card (e.g. stocks is always purple); this is the one thing about a
  // card no plugin owns, so a color edit from the layout page lives here
  // instead of in any feed's settings, and plugin-runtime.mjs re-applies
  // it on every push until cleared (feed disabled, card deleted, or
  // overwritten by another edit).
  cardOverrides: {},
};

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cached = { ...structuredClone(DEFAULT_CONFIG), ...JSON.parse(raw) };
  } catch {
    cached = structuredClone(DEFAULT_CONFIG);
  }
  return cached;
}

export function saveConfig(next) {
  cached = next;
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return cached;
}

export function updateConfig(mutator) {
  const cfg = loadConfig();
  mutator(cfg);
  return saveConfig(cfg);
}

export function getFeedConfig(feedId, defaults) {
  const cfg = loadConfig();
  if (!cfg.feeds[feedId]) {
    cfg.feeds[feedId] = { enabled: false, order: 0, settings: {}, ...defaults };
  }
  return cfg.feeds[feedId];
}

export function getCardOverride(cardId) {
  return loadConfig().cardOverrides[cardId] || null;
}

export function setCardOverride(cardId, patch) {
  updateConfig((cfg) => {
    cfg.cardOverrides[cardId] = { ...cfg.cardOverrides[cardId], ...patch };
  });
}

export function clearCardOverride(cardId) {
  updateConfig((cfg) => {
    delete cfg.cardOverrides[cardId];
  });
}

// A card's id can change out from under its override when an edit swaps
// the underlying value (e.g. stocks' id is `stocks-<symbol>`, so renaming
// AAPL to TSLA changes the id too) — without this, a color chosen before
// the rename would silently vanish on the very next push.
export function renameCardOverride(oldId, newId) {
  if (oldId === newId) return;
  updateConfig((cfg) => {
    if (cfg.cardOverrides[oldId]) {
      cfg.cardOverrides[newId] = cfg.cardOverrides[oldId];
      delete cfg.cardOverrides[oldId];
    }
  });
}

export function resetConfigCacheForTests() {
  cached = null;
}
