// Anthropic usage + spend. Uses the Admin API's usage/cost report endpoints
// (an Admin API key, not a regular API key — Anthropic issues these
// separately under Console > Settings > Admin API keys). Untested against
// a live key in this repo's dev environment (no key available here); the
// request shape below follows Anthropic's documented Usage & Cost Admin
// API. Flagging this the same way the firmware's card-schema commit
// flagged its own untested paths, rather than silently shipping unverified
// request code as if it were proven.

export const id = 'anthropic';
export const label = 'Anthropic usage';
export const description = 'Token usage and spend today, via the Anthropic Admin API.';
export const defaultIntervalSeconds = 300;
export const minIntervalSeconds = 60;
export const credentialsSchema = [
  {
    account: 'anthropic-admin-key',
    label: 'Anthropic Admin API key',
    helpUrl: 'https://console.anthropic.com/settings/admin-keys',
    required: true,
  },
];
export const settingsSchema = [];

const API_BASE = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

function todayUtcRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { startingAt: start.toISOString(), endingAt: now.toISOString() };
}

async function fetchJson(url, apiKey) {
  const res = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Anthropic rejected the Admin API key (401/403) — check it under Console > Settings > Admin API keys.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic usage API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function poll(ctx) {
  const apiKey = await ctx.getSecret('anthropic-admin-key');
  if (!apiKey) throw new Error('No Anthropic Admin API key stored yet — add one on the Feeds page.');

  const { startingAt, endingAt } = todayUtcRange();
  const params = new URLSearchParams({ starting_at: startingAt, ending_at: endingAt, bucket_width: '1d' });

  const [usage, cost] = await Promise.all([
    fetchJson(`${API_BASE}/organizations/usage_report/messages?${params}`, apiKey),
    fetchJson(`${API_BASE}/organizations/cost_report?${params}`, apiKey),
  ]);

  let totalTokens = 0;
  for (const bucket of usage.data || []) {
    for (const row of bucket.results || []) {
      totalTokens += (row.uncached_input_tokens || 0) + (row.output_tokens || 0) + (row.cache_read_input_tokens || 0);
    }
  }
  let spendUsd = 0;
  for (const bucket of cost.data || []) {
    for (const row of bucket.results || []) {
      spendUsd += Number(row.amount?.value || row.amount || 0);
    }
  }

  const now = Date.now();
  return {
    cards: [
      {
        id: 'anthropic-spend',
        title: 'Anthropic',
        value: spendUsd.toFixed(2),
        unit: '$',
        subtitle: 'spend today',
        state: 'neutral',
        icon: 'anthropic',
        color: '#CC785C',
        order: 3,
        updatedAt: now,
        ttlSeconds: 900,
      },
      {
        id: 'anthropic-tokens',
        // Nexus cbadc3da: same fix as openai.mjs's matching comment —
        // 'Anthropic tokens' doesn't fit the grid tile's title either and
        // would ellipsize the same way "OPENAI TOKENS" did. Icon+color
        // already say "Anthropic"; the unit suffix carries "tokens".
        title: 'Anthropic',
        value: totalTokens,
        unit: ' tok',
        subtitle: 'today',
        state: 'neutral',
        icon: 'anthropic',
        color: '#CC785C',
        // Lower priority than the ticket's named v1 feed list (spend
        // today, not token count) — pushed past the first page's worth of
        // cards rather than competing with it for a grid slot.
        order: 20,
        updatedAt: now,
        ttlSeconds: 900,
      },
    ],
  };
}
