// Stock quotes, keyless by default (Nexus c5941ef2 — "can we not just do a
// scrap to get stock values ... no API key and no signup"). Primary source
// is Stooq's free quote CSV; if that errors or has no data, falls back to
// Yahoo's unofficial v8 chart JSON. Finnhub (the old v1 implementation,
// Nexus c7aa8e00) is now opt-in only: store a key on the Feeds page and
// every configured symbol uses that instead of either free source.
//
// Verified live 2026-11-25: the exact Stooq URL this ticket names
// (stooq.com/q/l/?s=...&f=sd2t2ohlcvp&h&e=csv) currently 404s from this
// network behind a JS proof-of-work challenge ("This site requires
// JavaScript to verify your browser") — there is no key or header that
// gets past it from a plain server-side fetch. Every poll falls through
// to the Yahoo path in practice right now. Left coded as the first
// attempt anyway (cheap, still keyless, and Stooq's challenge may differ
// by network/IP or lift later) rather than removed — a plugin that only
// ever tries the source that works today would quietly stop noticing if
// the better one comes back. Yahoo's query1.finance.yahoo.com/v8 shape
// was confirmed live the same day: `meta.regularMarketPrice` and
// `meta.previousClose` are the fields that exist (no `marketState` field
// on this endpoint — market-open/closed is computed locally instead, see
// isMarketOpen() below).

export const id = 'stocks';
export const label = 'Stock quotes';
export const description = 'Up to 3 tickers’ last price and day change — free and keyless via Stooq/Yahoo by default. Add your own Finnhub key below to use that instead.';
export const defaultIntervalSeconds = 300; // 5 min — the market-hours floor; poll() itself throttles further to 30 min outside market hours
export const minIntervalSeconds = 60;
export const credentialsSchema = [
  {
    account: 'finnhub-api-key',
    label: 'Finnhub API key (optional)',
    helpUrl: 'https://finnhub.io/register',
    required: false, // Stooq/Yahoo fallback works keyless; this just skips straight to Finnhub when set
  },
];
export const settingsSchema = [
  // type 'stock-symbols' (Nexus 281ee5a2): one input per symbol, editing a
  // slot replaces that symbol — the buyer must click "+ Add" to get a
  // second tile, instead of a single comma-list field silently growing
  // into N tiles the moment they typed a comma. Storage stays the same
  // comma-joined string app.js's generic text-input path used, so existing
  // configs load unchanged.
  { key: 'symbols', label: 'Ticker symbol', type: 'stock-symbols', default: 'AAPL', max: 3 },
];

const USER_AGENT = 'Mozilla/5.0 (compatible; badge-console-host/1.0; +https://github.com/BadgePiratesLLC/badge-console-host)';
const FETCH_TIMEOUT_MS = 8000;
const MARKET_OPEN_INTERVAL_MS = 5 * 60 * 1000;
const MARKET_CLOSED_INTERVAL_MS = 30 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000; // extra cooldown on a 429, beyond the normal throttle

// symbol -> { price, prevClose, source, fetchedAt } — only ever holds a
// quote that actually succeeded at some point. Module-level and
// intentionally never cleared: this is the "last known good" cache the
// "never blank the tile" requirement depends on, and it needs to survive
// every poll() call for as long as the process runs.
const quoteCache = new Map();

// symbol -> epoch ms before which poll() won't re-fetch that symbol,
// separate from quoteCache so a symbol that has *never* succeeded can
// still be rate-gated (e.g. after a 429) without faking a cached quote.
const nextAllowedFetchAt = new Map();

export function _resetCacheForTests() {
  quoteCache.clear();
  nextAllowedFetchAt.clear();
}

function parseSymbols(settings) {
  const raw = settings?.symbols ?? settings?.symbol ?? 'AAPL';
  const symbols = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 3);
  return symbols.length ? symbols : ['AAPL'];
}

// NYSE/Nasdaq regular session, 9:30-16:00 America/New_York, Mon-Fri.
// Doesn't know about market holidays — a holiday reads as "open" by this
// check alone, but the feeds it guards (closed-market throttling) just
// mean one wasted poll on a holiday, not a wrong value.
export function isMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
    .formatToParts(now)
    .reduce((m, p) => ((m[p.type] = p.value), m), {});
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutesSinceMidnight = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return minutesSinceMidnight >= 9 * 60 + 30 && minutesSinceMidnight < 16 * 60;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStooq(symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&f=sd2t2ohlcvp&h&e=csv`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 429) throw new Error('Stooq rate limit hit (429)');
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq returned no data row');
  // f=sd2t2ohlcvp -> Symbol,Date,Time,Open,High,Low,Close,Volume,PrevClose
  const cols = lines[1].split(',');
  const close = cols[6];
  const prevClose = cols[8];
  if (!close || close === 'N/D' || !prevClose || prevClose === 'N/D') {
    throw new Error(`Stooq has no data for "${symbol}"`);
  }
  const price = Number(close);
  const prev = Number(prevClose);
  if (!Number.isFinite(price) || !Number.isFinite(prev)) throw new Error('Stooq returned unparsable numbers');
  return { price, prevClose: prev, source: 'stooq' };
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status === 429) throw new Error('Yahoo rate limit hit (429)');
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const body = await res.json();
  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta || body?.chart?.error) throw new Error(`Yahoo has no data for "${symbol}"`);
  const price = meta.regularMarketPrice;
  const prev = meta.previousClose ?? meta.chartPreviousClose;
  if (!Number.isFinite(price) || !Number.isFinite(prev)) throw new Error('Yahoo returned unparsable numbers');
  return { price, prevClose: prev, source: 'yahoo' };
}

async function fetchFinnhub(symbol, apiKey) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const res = await fetchWithTimeout(url);
  if (res.status === 401 || res.status === 403) throw new Error('Finnhub rejected the API key (401/403)');
  if (res.status === 429) throw new Error('Finnhub rate limit hit (429)');
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const q = await res.json();
  if (q.c === 0 && q.pc === 0) throw new Error(`Finnhub has no data for "${symbol}"`);
  return { price: q.c, prevClose: q.pc, source: 'finnhub' };
}

async function fetchQuote(symbol, apiKey) {
  if (apiKey) return fetchFinnhub(symbol, apiKey);
  try {
    return await fetchStooq(symbol);
  } catch (stooqErr) {
    try {
      return await fetchYahoo(symbol);
    } catch (yahooErr) {
      throw new Error(`Stooq (${stooqErr.message}) and Yahoo (${yahooErr.message}) both failed for "${symbol}"`);
    }
  }
}

function buildCard(symbol, quote, { open, stale, order }) {
  const { price, prevClose } = quote;
  const change = price - prevClose;
  const pct = prevClose ? (change / prevClose) * 100 : null;
  const up = change >= 0;

  let state = 'ok';
  let subtitle = `$${price.toFixed(2)}`;
  if (stale) {
    state = 'warn';
    subtitle = `$${price.toFixed(2)} · stale`;
  } else if (!open) {
    state = 'neutral';
    subtitle = `$${price.toFixed(2)} · closed`;
  }

  return {
    id: `stocks-${symbol.toLowerCase()}`,
    title: symbol,
    // Nexus 4ea60fad: the approved mockup's headline number for a stock
    // tile is the day's percent move, not the raw price — price is one
    // tap away, in subtitle. Direction now lives only in the icon
    // (stock-up/stock-down); `state` is reserved for data health
    // (ok/closed/warn-stale), not up-vs-down.
    value: pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—',
    unit: '',
    subtitle,
    state,
    icon: up ? 'stock-up' : 'stock-down',
    color: '#6C4FD6',
    order,
    updatedAt: Date.now(),
    ttlSeconds: 1800,
  };
}

export async function poll(ctx) {
  const symbols = parseSymbols(ctx.settings);
  const apiKey = await ctx.getSecret('finnhub-api-key');
  const open = isMarketOpen();
  const now = Date.now();
  const minGapMs = open ? MARKET_OPEN_INTERVAL_MS : MARKET_CLOSED_INTERVAL_MS;
  const errors = [];

  const results = await Promise.all(
    symbols.map(async (symbol, index) => {
      const cached = quoteCache.get(symbol);
      const dueForFetch = now >= (nextAllowedFetchAt.get(symbol) ?? 0);
      if (!dueForFetch) {
        if (!cached) {
          errors.push(`${symbol}: backing off until ${new Date(nextAllowedFetchAt.get(symbol)).toISOString()}`);
          return null;
        }
        return buildCard(symbol, cached, { open, stale: false, order: 2 + index });
      }
      try {
        const quote = await fetchQuote(symbol, apiKey);
        quoteCache.set(symbol, { ...quote, fetchedAt: now });
        nextAllowedFetchAt.set(symbol, now + minGapMs);
        return buildCard(symbol, quote, { open, stale: false, order: 2 + index });
      } catch (e) {
        const backoff = /429/.test(e.message) ? Math.max(minGapMs, RATE_LIMIT_BACKOFF_MS) : minGapMs;
        nextAllowedFetchAt.set(symbol, now + backoff);
        if (cached) {
          return buildCard(symbol, cached, { open, stale: true, order: 2 + index });
        }
        errors.push(`${symbol}: ${e.message}`);
        return null;
      }
    }),
  );

  const cards = results.filter(Boolean);
  if (cards.length === 0) {
    throw new Error(errors.join('; ') || 'No symbols configured.');
  }
  return { cards };
}
