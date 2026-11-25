// Contract tests for the stocks plugin (Nexus c7aa8e00, "Phase 4"). Closes
// the gap plugins-live.test.mjs and plugins-anthropic-openai.test.mjs both
// flag in their file headers: stocks needs a Finnhub API key this dev
// environment doesn't have, so it can't be a live test — but its whole
// point per the ticket ("respect the rate limit and say so in the UI") is
// the 429 path, which is exactly the kind of thing worth mocking rather
// than leaving unverified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poll as pollStocks, description } from '../src/plugins/stocks.mjs';

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

test('stocks plugin throws a clear error when no key is stored, and never calls the API', async () => {
  let called = false;
  await withMockFetch(
    async () => { called = true; throw new Error('should not be called'); },
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbol: 'AAPL' }, getSecret: async () => null }),
        /No Finnhub API key stored/,
      );
    },
  );
  assert.equal(called, false);
});

test('stocks plugin surfaces a clear error on a rejected key (401), not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(401, { error: 'unauthorized' }),
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbol: 'AAPL' }, getSecret: async () => 'bad-key' }),
        /Finnhub rejected the API key/,
      );
    },
  );
});

test('stocks plugin surfaces the free-tier rate limit (429) as an actionable error, not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(429, { error: 'rate limit exceeded' }),
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbol: 'AAPL' }, getSecret: async () => 'a-key' }),
        /Finnhub rate limit hit \(429\).*lengthen the poll interval/,
      );
    },
  );
});

test('stocks plugin surfaces a provider outage (500) as an error, not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(500, 'internal error'),
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbol: 'AAPL' }, getSecret: async () => 'a-key' }),
        /Finnhub returned HTTP 500/,
      );
    },
  );
});

test('stocks plugin surfaces an unknown symbol as an error rather than a zero price', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { c: 0, d: 0, dp: 0, pc: 0 }),
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbol: 'ZZZZ' }, getSecret: async () => 'a-key' }),
        /no data for symbol "ZZZZ"/,
      );
    },
  );
});

test('stocks plugin propagates a network-level failure instead of swallowing it', async () => {
  await withMockFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND finnhub.io'); },
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbol: 'AAPL' }, getSecret: async () => 'a-key' }),
        /ENOTFOUND/,
      );
    },
  );
});

test('stocks plugin returns a priced quote card on success, uppercasing the symbol', async () => {
  await withMockFetch(
    async (url) => {
      assert.match(String(url), /symbol=AAPL/);
      return jsonResponse(200, { c: 227.5, d: 1.25, dp: 0.55, pc: 226.25 });
    },
    async () => {
      const result = await pollStocks({ settings: { symbol: 'aapl' }, getSecret: async () => 'a-key' });
      assert.equal(result.cards.length, 1);
      const card = result.cards[0];
      assert.equal(card.id, 'stocks-aapl');
      assert.equal(card.title, 'AAPL');
      // Nexus 4ea60fad: the headline value is the day's percent move (the
      // approved mockup's tile design), not the raw price — price moved to
      // subtitle.
      assert.equal(card.value, '+0.6%');
      assert.equal(card.unit, '');
      assert.match(card.subtitle, /\$227\.50/);
      assert.equal(card.state, 'ok');
      assert.equal(card.icon, 'stock-up');
    },
  );
});

test('stocks plugin marks a down day as warn, not ok', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { c: 100, d: -2, dp: -1.9, pc: 102 }),
    async () => {
      const result = await pollStocks({ settings: { symbol: 'MSFT' }, getSecret: async () => 'a-key' });
      assert.equal(result.cards[0].state, 'warn');
      assert.equal(result.cards[0].icon, 'stock-down');
    },
  );
});

test('stocks plugin description states the free-tier rate limit up front, per the ticket', () => {
  assert.match(description, /60 calls\/min/);
});
