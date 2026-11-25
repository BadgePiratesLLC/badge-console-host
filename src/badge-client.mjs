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
export async function pushCards(host, port, cards, { timeoutMs = 5000, actionPort } = {}) {
  const token = await getBadgeToken();
  if (!token) throw new Error('Badge is not paired yet — no auth token stored.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Auth-Token': token };
    // Tells the badge where to call back on a button-card tap (see
    // action-server.mjs). Omitted entirely if this host has no action
    // server running — the badge just can't report taps, nothing else
    // about the push changes.
    if (actionPort) headers['X-Action-Port'] = String(actionPort);
    const res = await fetch(badgeUrl(host, port, '/cards'), {
      method: 'POST',
      headers,
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
 * Pairing (Nexus 2f45b023): exchange the 6-digit code shown on the badge's
 * own Pair screen for its long-lived device token, over POST /pair. The
 * human never sees or types that token — this is the one function that
 * does, and only once per pairing. A 401 means the code was wrong, 410
 * means it expired or was already used (badge generates a fresh one each
 * time its Pair screen opens), 429 means the badge's own lockout tripped
 * after repeated wrong codes; a network error means wrong host/port or the
 * badge is off. All four are reported back verbatim rather than collapsed
 * into one message, since the fix a buyer needs is different for each.
 */
export async function exchangePairCode(host, port, code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(badgeUrl(host, port, '/pair'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, reason: 'Badge rejected that code — check it against the badge\'s Pair screen.' };
    if (res.status === 410) return { ok: false, reason: 'That code expired or was already used — get a fresh one from the badge\'s Pair screen.' };
    if (res.status === 429) return { ok: false, reason: 'Too many wrong codes were entered — the badge is locked out for a few minutes.' };
    if (!res.ok) return { ok: false, reason: `Badge responded HTTP ${res.status}.` };
    const body = await res.json().catch(() => null);
    if (!body?.token) return { ok: false, reason: 'Badge accepted the code but did not return a token.' };
    return { ok: true, token: body.token };
  } catch (e) {
    return { ok: false, reason: `Could not reach ${host}:${port} — ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}
