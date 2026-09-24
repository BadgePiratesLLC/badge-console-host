// OpenAI usage + spend, via the platform Usage/Costs API. Needs an Admin
// API key (organization-level "api.usage.read" scope), not a project key.
// Same caveat as anthropic.mjs: request shape follows OpenAI's documented
// /v1/organization/usage and /v1/organization/costs endpoints, untested
// against a live key in this repo's dev environment.

export const id = 'openai';
export const label = 'OpenAI usage';
export const description = 'Token usage and spend today, via the OpenAI organization Usage/Costs API.';
export const defaultIntervalSeconds = 300;
export const minIntervalSeconds = 60;
export const needsCredentials = ['openai-admin-key'];
export const settingsSchema = [];

const API_BASE = 'https://api.openai.com/v1/organization';

async function fetchJson(url, apiKey) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401 || res.status === 403) {
    throw new Error('OpenAI rejected the Admin API key (401/403) — check it has the api.usage.read scope.');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI usage API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function startOfTodayUnix() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.floor(start.getTime() / 1000);
}

export async function poll(ctx) {
  const apiKey = await ctx.getSecret('openai-admin-key');
  if (!apiKey) throw new Error('No OpenAI Admin API key stored yet — add one on the Feeds page.');

  const startTime = startOfTodayUnix();
  const params = new URLSearchParams({ start_time: String(startTime), bucket_width: '1d' });

  const [usage, costs] = await Promise.all([
    fetchJson(`${API_BASE}/usage/completions?${params}`, apiKey),
    fetchJson(`${API_BASE}/costs?${params}`, apiKey),
  ]);

  let totalTokens = 0;
  for (const bucket of usage.data || []) {
    for (const row of bucket.results || []) {
      totalTokens += (row.input_tokens || 0) + (row.output_tokens || 0);
    }
  }
  let spendUsd = 0;
  for (const bucket of costs.data || []) {
    for (const row of bucket.results || []) {
      spendUsd += Number(row.amount?.value || 0);
    }
  }

  const now = Date.now();
  return {
    cards: [
      {
        id: 'openai-spend',
        title: 'OpenAI',
        value: spendUsd.toFixed(2),
        unit: '$',
        subtitle: 'spend today',
        state: 'neutral',
        updatedAt: now,
        ttlSeconds: 900,
      },
      {
        id: 'openai-tokens',
        title: 'OpenAI tokens',
        value: totalTokens,
        unit: '',
        subtitle: 'today',
        state: 'neutral',
        updatedAt: now,
        ttlSeconds: 900,
      },
    ],
  };
}
