// Contract tests for the two Admin-API-key plugins (Nexus d46f4521). Neither
// this dev environment nor CI has a real Anthropic/OpenAI Admin API key, so
// this can't be a live test the way weather/sports/openclaw are in
// plugins-live.test.mjs. Instead it mocks global.fetch to prove the one
// thing the ticket actually asks for: a bad key or a provider outage must
// throw a clear error (which the runtime turns into status.lastError), and
// a real success response must be summed into the right card values — never
// a silently-swallowed failure that reads to the buyer as a fabricated zero.
//
// Note: plugins-live.test.mjs's file header claims anthropic/openai/stocks
// are "contract-tested via plugin-runtime.test.mjs's fakes" — that file only
// ever exercises synthetic fakePlugin() objects, never these two modules, so
// that claim was never true. This file is what actually closes that gap for
// anthropic and openai; stocks gets the same treatment in
// plugins-stocks.test.mjs (Nexus c7aa8e00).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poll as pollAnthropic } from '../src/plugins/anthropic.mjs';
import { poll as pollOpenAI } from '../src/plugins/openai.mjs';

function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// --- Anthropic ---

test('anthropic plugin throws a clear error when no key is stored, and never calls the API', async () => {
  let called = false;
  await withMockFetch(
    async () => { called = true; throw new Error('should not be called'); },
    async () => {
      await assert.rejects(
        () => pollAnthropic({ settings: {}, getSecret: async () => null }),
        /No Anthropic Admin API key stored/,
      );
    },
  );
  assert.equal(called, false);
});

test('anthropic plugin surfaces a clear error on a rejected key (401), not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(401, { error: 'unauthorized' }),
    async () => {
      await assert.rejects(
        () => pollAnthropic({ settings: {}, getSecret: async () => 'bad-key' }),
        /Anthropic rejected the Admin API key/,
      );
    },
  );
});

test('anthropic plugin surfaces provider outage (500) as an error, not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(500, 'internal error'),
    async () => {
      await assert.rejects(
        () => pollAnthropic({ settings: {}, getSecret: async () => 'a-key' }),
        /Anthropic usage API returned HTTP 500/,
      );
    },
  );
});

test('anthropic plugin propagates a network-level failure instead of swallowing it', async () => {
  await withMockFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND api.anthropic.com'); },
    async () => {
      await assert.rejects(
        () => pollAnthropic({ settings: {}, getSecret: async () => 'a-key' }),
        /ENOTFOUND/,
      );
    },
  );
});

test('anthropic plugin sums usage + cost into the two expected cards on success', async () => {
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('usage_report/messages')) {
        return jsonResponse(200, {
          data: [{ results: [
            { uncached_input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
            { uncached_input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0 },
          ] }],
        });
      }
      if (u.includes('cost_report')) {
        return jsonResponse(200, {
          data: [{ results: [{ amount: { value: '1.25' } }, { amount: { value: '0.75' } }] }],
        });
      }
      throw new Error(`unexpected URL ${u}`);
    },
    async () => {
      const result = await pollAnthropic({ settings: {}, getSecret: async () => 'a-key' });
      assert.equal(result.cards.length, 2);
      const spend = result.cards.find((c) => c.id === 'anthropic-spend');
      const tokens = result.cards.find((c) => c.id === 'anthropic-tokens');
      assert.equal(spend.value, '2.00');
      assert.equal(spend.unit, '$');
      assert.equal(tokens.value, 170);
    },
  );
});

// --- OpenAI ---

test('openai plugin throws a clear error when no key is stored, and never calls the API', async () => {
  let called = false;
  await withMockFetch(
    async () => { called = true; throw new Error('should not be called'); },
    async () => {
      await assert.rejects(
        () => pollOpenAI({ settings: {}, getSecret: async () => null }),
        /No OpenAI Admin API key stored/,
      );
    },
  );
  assert.equal(called, false);
});

test('openai plugin surfaces a clear error on a rejected key (403), not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(403, { error: 'forbidden' }),
    async () => {
      await assert.rejects(
        () => pollOpenAI({ settings: {}, getSecret: async () => 'bad-key' }),
        /OpenAI rejected the Admin API key/,
      );
    },
  );
});

test('openai plugin surfaces provider outage (503) as an error, not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(503, 'service unavailable'),
    async () => {
      await assert.rejects(
        () => pollOpenAI({ settings: {}, getSecret: async () => 'a-key' }),
        /OpenAI usage API returned HTTP 503/,
      );
    },
  );
});

test('openai plugin propagates a network-level failure instead of swallowing it', async () => {
  await withMockFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND api.openai.com'); },
    async () => {
      await assert.rejects(
        () => pollOpenAI({ settings: {}, getSecret: async () => 'a-key' }),
        /ENOTFOUND/,
      );
    },
  );
});

test('openai plugin sums usage + costs into the two expected cards on success', async () => {
  await withMockFetch(
    async (url) => {
      const u = String(url);
      if (u.includes('/usage/completions')) {
        return jsonResponse(200, {
          data: [{ results: [
            { input_tokens: 200, output_tokens: 40 },
            { input_tokens: 10, output_tokens: 5 },
          ] }],
        });
      }
      if (u.includes('/costs')) {
        return jsonResponse(200, {
          data: [{ results: [{ amount: { value: 3.5 } }, { amount: { value: 0.5 } }] }],
        });
      }
      throw new Error(`unexpected URL ${u}`);
    },
    async () => {
      const result = await pollOpenAI({ settings: {}, getSecret: async () => 'a-key' });
      assert.equal(result.cards.length, 2);
      const spend = result.cards.find((c) => c.id === 'openai-spend');
      const tokens = result.cards.find((c) => c.id === 'openai-tokens');
      assert.equal(spend.value, '4.00');
      assert.equal(spend.unit, '$');
      assert.equal(tokens.value, 255);
    },
  );
});
