// Talks to the badge's POST /cards endpoint (docs/CardSchema.md in the
// QACode_27 firmware repo is the wire contract this mirrors). The badge
// never receives anything but cards and the one shared auth token it
// generated for itself — see credential-store.mjs for where that token
// lives on this side.

import { getSecret, setSecret } from './credential-store.mjs';

const SERVICE = 'badge-console-host';
const TOKEN_ACCOUNT = 'badge-token';

export async function getBadgeToken() {
  return getSecret(SERVICE, TOKEN_ACCOUNT);
}

export async function setBadgeToken(token) {
  return setSecret(SERVICE, TOKEN_ACCOUNT, token);
}

function badgeUrl(host, port, pathname) {
  const p = Number(port) || 80;
  return `http://${host}:${p}${pathname}`;
}

/**
 * POST an array of cards to the badge. Throws on network failure, non-2xx,
 * or a missing/expired token — callers (the poll scheduler, or the pairing
 * flow) decide what that means for their own status reporting; this
 * function's only job is the HTTP round trip.
 */
export async function pushCards(host, port, cards, { timeoutMs = 5000 } = {}) {
  const token = await getBadgeToken();
  if (!token) throw new Error('Badge is not paired yet — no auth token stored.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(badgeUrl(host, port, '/cards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify(cards),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`Badge rejected push (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    return { ok: true, status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pairing: try a harmless empty POST /cards with the candidate token. 401
 * means wrong token; a network error means wrong host/port or badge is off.
 * Both are reported back verbatim rather than collapsed into one message,
 * since the fix a buyer needs is different for each.
 */
export async function testPairing(host, port, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(badgeUrl(host, port, '/cards'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: '[]',
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, reason: 'Badge rejected the token — check it against the badge\'s Wi-Fi setup portal (GET /token).' };
    if (!res.ok) return { ok: false, reason: `Badge responded HTTP ${res.status}.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Could not reach ${host}:${port} — ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}
