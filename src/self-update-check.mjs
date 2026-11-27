// Checks GitHub Releases for a newer badge-console-host than the one
// currently running, and surfaces a dismissable prompt in the config page —
// the "auto-update inside the app" half of Nexus b1ad1a04 (the install side
// is the OS-native installers in install/; this module never downloads or
// replaces the running binary itself, see docs/DECISIONS.md "Self-update:
// check-and-prompt, not silent self-replace").

import { log } from './logger.mjs';

const REPO = 'BadgePiratesLLC/badge-console-host';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let cached = { checkedAt: 0, currentVersion: null, latestVersion: null, latestUrl: null, updateAvailable: false, error: null };

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export async function checkForSelfUpdate(currentVersion, { force = false, timeoutMs = 5000 } = {}) {
  const now = Date.now();
  if (!force && cached.checkedAt && now - cached.checkedAt < CHECK_INTERVAL_MS) {
    return cached;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'badge-console-host-self-update-check' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`);
    const data = await res.json();
    const latestVersion = String(data.tag_name || '').replace(/^v/, '');
    cached = {
      checkedAt: now,
      currentVersion,
      latestVersion,
      latestUrl: data.html_url || `https://github.com/${REPO}/releases/latest`,
      updateAvailable: isNewer(latestVersion, currentVersion),
      error: null,
    };
  } catch (e) {
    cached = { ...cached, checkedAt: now, currentVersion, error: e.message };
    log.error(`Self-update check failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  return cached;
}

export function getCachedSelfUpdateStatus() {
  return cached;
}
