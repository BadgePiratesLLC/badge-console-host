// Non-secret settings only. Credential values never pass through here —
// see credential-store.mjs. This file just remembers *which* account names
// a feed needs, plus the buyer-facing knobs (on/off, interval, order,
// per-feed settings like a stock symbol or a team id).

import fs from 'node:fs';
import { HOME_DIR, CONFIG_PATH } from './paths.mjs';

const DEFAULT_CONFIG = {
  badge: { host: '', port: 80, paired: false },
  feeds: {}, // feedId -> { enabled, intervalSeconds, order, settings }
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

export function resetConfigCacheForTests() {
  cached = null;
}
