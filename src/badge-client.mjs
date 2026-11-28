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
 * GET the badge's own card snapshot (Nexus 831d8e1a). Unauthenticated on
 * the badge's side (same reasoning as the layout page — see
 * UsageServer.cpp's handleCardsGet) and used here only to reconcile this
 * host's idea of what it owns against what the badge is actually holding,
 * never to render anything a buyer sees.
 */
export async function getCards(host, port, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(badgeUrl(host, port, '/cards'), { signal: controller.signal });
    if (!res.ok) throw new Error(`Badge rejected GET /cards (HTTP ${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET the badge's firmware-direct Home Assistant watch list (Nexus
 * 831d8e1a) — the entities /ha-config told the badge to watch straight
 * from HA over its own websocket, independent of anything this host's
 * homeassistant plugin pushes. Token-gated like /cards POST. Used to warn
 * when the same entity is double-watched by both paths (see server.mjs's
 * /api/state haOverlap field).
 */
export async function getHaStatus(host, port, { timeoutMs = 4000 } = {}) {
  const token = await getBadgeToken();
  if (!token) throw new Error('Badge is not paired yet — no auth token stored.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(badgeUrl(host, port, '/ha-status'), {
      headers: { 'X-Auth-Token': token },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Badge rejected /ha-status (HTTP ${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET the badge's own OTA status (Nexus ad98fbf6): the version it's
 * currently running plus whatever its OtaWorker last found during its
 * periodic 6h check or an explicit checkBadgeForUpdate() below —
 * token-gated the same way /cards is. Shape: { currentVersion,
 * availableVersion: string|null, checking: boolean }.
 */
export async function getOtaStatus(host, port, { timeoutMs = 4000 } = {}) {
  const token = await getBadgeToken();
  if (!token) throw new Error('Badge is not paired yet — no auth token stored.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(badgeUrl(host, port, '/ota-status'), {
      headers: { 'X-Auth-Token': token },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Badge rejected /ota-status (HTTP ${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /ota-check — ask the badge to re-check its manifest right now
 * instead of waiting for its own 6h background cycle. Non-blocking on the
 * badge's side; the result shows up on the NEXT getOtaStatus() call, not
 * in this one's response.
 */
export async function checkBadgeForUpdate(host, port, { timeoutMs = 5000 } = {}) {
  const token = await getBadgeToken();
  if (!token) throw new Error('Badge is not paired yet — no auth token stored.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(badgeUrl(host, port, '/ota-check'), {
      method: 'POST',
      headers: { 'X-Auth-Token': token },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Badge rejected /ota-check (HTTP ${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /ota-update — tell the badge to install whatever version its last
 * check reported available, then CONFIRM the badge actually came back on
 * that version before reporting success (Nexus 4e6cc6f3 / ad98fbf6).
 *
 * The badge blocks on its side for the whole download/flash and a
 * successful install restarts it mid-response, so the connection usually
 * just drops (or our own timeoutMs abort fires first). A dropped
 * connection is NOT evidence of success: it looks the same as a badge
 * that rejected the signature and rebooted, browned out, or fell off
 * Wi-Fi. Previously a drop/abort was returned as { ok: true, restarted:
 * true }, so the host reported "success" for an install that never
 * landed. Now:
 *   1. read /ota-status first, which gives the version we expect to land
 *      (availableVersion) and the one we are leaving (currentVersion);
 *   2. POST /ota-update; if the badge answers with an error, throw it as before;
 *   3. on drop/abort OR a 2xx, re-poll /ota-status until currentVersion
 *      equals the expected version → { ok: true, verified: true, ... };
 *      if the window expires and the badge is unreachable or still on
 *      another version, throw. The route turns that into a 502.
 */
export async function triggerBadgeUpdate(host, port, {
  timeoutMs = 45000,
  verifyTimeoutMs = Number(process.env.BADGE_OTA_VERIFY_TIMEOUT_MS) || 180000,
  pollIntervalMs = Number(process.env.BADGE_OTA_VERIFY_POLL_MS) || 5000,
} = {}) {
  const token = await getBadgeToken();
  if (!token) throw new Error('Badge is not paired yet — no auth token stored.');

  const before = await getOtaStatus(host, port);
  const expected = before && before.availableVersion;
  if (!expected) throw new Error('no update available - POST /ota-check first');
  const previous = before.currentVersion ?? null;

  let restarted = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(badgeUrl(host, port, '/ota-update'), {
      method: 'POST',
      headers: { 'X-Auth-Token': token },
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let reason = text;
      try { reason = JSON.parse(text).error || text; } catch { /* non-JSON body, use as-is */ }
      throw new Error(reason || `Badge rejected /ota-update (HTTP ${res.status})`);
    }
  } catch (e) {
    // A real failure the badge told us about explicitly (the `!res.ok`
    // branch above) is a plain Error, so rethrow it. AbortError (our
    // timeout) or a TypeError "fetch failed" (socket reset/refused) is what
    // a badge restarting mid-request looks like, but it is only a
    // *candidate* success until the version check below confirms it.
    if (!(e.name === 'AbortError' || e instanceof TypeError)) throw e;
    restarted = true;
  } finally {
    clearTimeout(timer);
  }

  const deadline = Date.now() + verifyTimeoutMs;
  let lastSeen = null;
  let lastErr = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const st = await getOtaStatus(host, port);
      lastSeen = st.currentVersion ?? null;
      lastErr = null;
      if (lastSeen === expected) {
        return { ok: true, verified: true, restarted, previousVersion: previous, currentVersion: lastSeen };
      }
    } catch (e) {
      lastErr = e; // still flashing/rebooting, so keep polling until the deadline
    }
  }
  const secs = Math.round(verifyTimeoutMs / 1000);
  if (lastSeen !== null && lastErr === null) {
    throw new Error(`Update did not land: badge is running ${lastSeen} ${secs}s after /ota-update, expected ${expected}.`);
  }
  throw new Error(`Could not confirm the update: badge did not answer /ota-status on ${expected} within ${secs}s (last error: ${lastErr ? lastErr.message : 'none'}).`);
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
