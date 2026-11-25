// Stock quote via Finnhub's free tier (documented limit: 60 API calls/min
// on the free plan, shared across every endpoint on the key — not just
// this feed). Free-tier quotes are real-time-ish for US exchanges and need
// no paid plan, matching the ticket's "respect the rate limit and say so
// in the UI" instruction: minIntervalSeconds below is set well under the
// per-key limit for a single symbol, and the UI-facing description says so
// plainly rather than leaving it to be discovered as a 429.

export const id = 'stocks';
export const label = 'Stock quote';
export const description = 'One symbol’s quote via Finnhub’s free tier (60 calls/min per key — keep the interval well above 1s if you add more symbols later).';
export const defaultIntervalSeconds = 60;
export const minIntervalSeconds = 15;
export const needsCredentials = ['finnhub-api-key'];
export const settingsSchema = [
  { key: 'symbol', label: 'Ticker symbol', type: 'text', default: 'AAPL' },
];

export async function poll(ctx) {
  const apiKey = await ctx.getSecret('finnhub-api-key');
  if (!apiKey) throw new Error('No Finnhub API key stored yet — add one (free at finnhub.io) on the Feeds page.');
  const symbol = (ctx.settings.symbol || 'AAPL').toUpperCase();

  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
  if (res.status === 401 || res.status === 403) {
    throw new Error('Finnhub rejected the API key (401/403).');
  }
  if (res.status === 429) {
    throw new Error('Finnhub rate limit hit (429) — free tier is 60 calls/min per key; lengthen the poll interval.');
  }
  if (!res.ok) {
    throw new Error(`Finnhub returned HTTP ${res.status}.`);
  }
  const q = await res.json();
  if (q.c === 0 && q.pc === 0) {
    throw new Error(`Finnhub returned no data for symbol "${symbol}" — check the ticker.`);
  }

  const price = q.c;
  const change = q.d;
  const pct = q.dp;
  const up = change == null ? true : change >= 0;
  const now = Date.now();
  return {
    cards: [
      {
        id: `stocks-${symbol.toLowerCase()}`,
        title: symbol,
        // Nexus 4ea60fad: the approved mockup's headline number for a
        // stock tile is the day's percent move, not the raw price — the
        // price is still one tap away, in subtitle.
        value: pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—',
        unit: '',
        subtitle: price != null ? `$${price.toFixed(2)}` : '',
        state: change == null ? 'neutral' : change >= 0 ? 'ok' : 'warn',
        icon: up ? 'stock-up' : 'stock-down',
        color: '#6C4FD6',
        order: 2,
        updatedAt: now,
        ttlSeconds: 300,
      },
    ],
  };
}
