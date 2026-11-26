// Contract tests for the stocks plugin (Nexus c5941ef2, "keyless stock
// quote feed"). Covers: the Stooq->Yahoo keyless fallback chain, the
// optional-Finnhub-key override path, up-to-3-symbol tiles, the
// closed-market state, and the "never blank a tile" staleness contract —
// each mocked via fetch, since none of these need (or, for Stooq right
// now, even support) a real network call to exercise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  poll as pollStocks,
  description,
  isMarketOpen,
  onEditValue,
  onRemoveInstance,
  _resetCacheForTests,
} from '../src/plugins/stocks.mjs';

function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function textResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const STOOQ_AAPL_CSV = 'Symbol,Date,Time,Open,High,Low,Close,Volume,PrevClose\nAAPL.US,2026-11-25,21:00:00,225.00,228.00,224.50,227.50,5000000,226.25\n';
const STOOQ_NO_DATA_CSV = 'Symbol,Date,Time,Open,High,Low,Close,Volume,PrevClose\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n';

function yahooChart(price, prevClose) {
  return { chart: { result: [{ meta: { regularMarketPrice: price, previousClose: prevClose } }], error: null } };
}

const MARKET_OPEN_UTC = new Date('2026-11-25T18:00:00Z'); // Wed 13:00 America/New_York
const MARKET_CLOSED_UTC = new Date('2026-11-25T02:00:00Z'); // Tue 21:00 America/New_York

// poll() reads the wall clock itself (`new Date()` inside isMarketOpen(),
// `Date.now()` for the staleness throttle) — these tests need a fixed
// instant regardless of when CI actually runs, so patch the global Date
// class for the duration of the callback.
async function withFixedNow(ms, fn) {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      return args.length ? new RealDate(...args) : new RealDate(ms);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = FixedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

test('isMarketOpen recognizes regular NYSE hours and after-hours/weekends', () => {
  assert.equal(isMarketOpen(MARKET_OPEN_UTC), true);
  assert.equal(isMarketOpen(MARKET_CLOSED_UTC), false);
  assert.equal(isMarketOpen(new Date('2026-11-28T18:00:00Z')), false); // Saturday
});

test('stocks plugin fetches Stooq first and returns a priced card, no key needed', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async (url) => {
      assert.match(String(url), /stooq\.com.*s=aapl\.us/);
      return textResponse(200, STOOQ_AAPL_CSV);
    },
    async () => withFixedNow(MARKET_OPEN_UTC.getTime(), async () => {
      const result = await pollStocks({ settings: { symbols: 'aapl' }, getSecret: async () => null });
      assert.equal(result.cards.length, 1);
      const card = result.cards[0];
      assert.equal(card.id, 'stocks-aapl');
      assert.equal(card.title, 'AAPL');
      assert.equal(card.value, '+0.6%');
      assert.match(card.subtitle, /\$227\.50/);
      assert.equal(card.state, 'ok');
      assert.equal(card.icon, 'stock-up');
    }),
  );
});

test('stocks plugin falls back to Yahoo when Stooq errors, without throwing', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async (url) => {
      if (String(url).includes('stooq.com')) return textResponse(404, 'not found');
      assert.match(String(url), /query1\.finance\.yahoo\.com.*chart\/AAPL/);
      return jsonResponse(200, yahooChart(227.5, 226.25));
    },
    async () => withFixedNow(MARKET_OPEN_UTC.getTime(), async () => {
      const result = await pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => null });
      assert.equal(result.cards[0].value, '+0.6%');
      assert.equal(result.cards[0].state, 'ok');
    }),
  );
});

test('stocks plugin throws a combined error when both Stooq and Yahoo fail and nothing is cached yet', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async () => textResponse(500, 'boom'),
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => null }),
        /AAPL.*Stooq.*Yahoo/,
      );
    },
  );
});

test('stocks plugin surfaces an unknown symbol (Stooq N/D) by falling to Yahoo, not a zero', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async (url) => {
      if (String(url).includes('stooq.com')) return textResponse(200, STOOQ_NO_DATA_CSV);
      return jsonResponse(404, { chart: { result: null, error: { code: 'Not Found' } } });
    },
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbols: 'ZZZZ' }, getSecret: async () => null }),
        /ZZZZ/,
      );
    },
  );
});

test('a previously-successful symbol goes stale (warn) instead of blank when every source then fails', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  let callCount = 0;
  await withMockFetch(
    async () => {
      callCount += 1;
      if (callCount === 1) return textResponse(200, STOOQ_AAPL_CSV); // first poll succeeds via Stooq
      return textResponse(500, 'provider outage'); // every later source call fails
    },
    async () => {
      const first = await withFixedNow(MARKET_OPEN_UTC.getTime(), () =>
        pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => null }));
      assert.equal(first.cards[0].state, 'ok');

      // 31 minutes later, still inside market hours: past the 5-minute
      // throttle, so poll() actually re-fetches and hits the mocked 500.
      const second = await withFixedNow(MARKET_OPEN_UTC.getTime() + 31 * 60 * 1000, () =>
        pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => null }));
      assert.equal(second.cards.length, 1); // never blank
      assert.equal(second.cards[0].state, 'warn');
      assert.match(second.cards[0].subtitle, /stale/);
      assert.equal(second.cards[0].value, '+0.6%'); // same last-known numbers, not zeroed
    },
  );
});

test('stocks plugin marks the market-closed state as neutral, not warn, with the same numbers', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withFixedNow(MARKET_CLOSED_UTC.getTime(), () => withMockFetch(
    async () => textResponse(200, STOOQ_AAPL_CSV),
    async () => {
      const result = await pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => null });
      assert.equal(result.cards[0].state, 'neutral');
      assert.match(result.cards[0].subtitle, /closed/);
      assert.equal(result.cards[0].value, '+0.6%');
    },
  ));
});

test('stocks plugin builds up to 3 tiles from a comma-separated symbol list, each its own card', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async (url) => {
      const m = String(url).match(/s=([a-z]+)\.us/);
      const sym = m[1].toUpperCase();
      const prices = { AAPL: [227.5, 226.25], MSFT: [100, 102], TSLA: [50, 49] };
      const [price, prev] = prices[sym];
      return textResponse(200, `Symbol,Date,Time,Open,High,Low,Close,Volume,PrevClose\n${sym}.US,d,t,o,h,l,${price},v,${prev}\n`);
    },
    async () => {
      const result = await pollStocks({ settings: { symbols: 'aapl, msft, tsla' }, getSecret: async () => null });
      assert.equal(result.cards.length, 3);
      assert.deepEqual(result.cards.map((c) => c.title), ['AAPL', 'MSFT', 'TSLA']);
      assert.equal(result.cards[1].icon, 'stock-down'); // MSFT: 100 < 102
      assert.equal(result.cards[2].icon, 'stock-up'); // TSLA: 50 > 49
    },
  );
});

test('more than 3 configured symbols is capped at 3', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async () => textResponse(200, STOOQ_AAPL_CSV),
    async () => {
      const result = await pollStocks({ settings: { symbols: 'AAPL,MSFT,TSLA,GOOG,AMZN' }, getSecret: async () => null });
      assert.equal(result.cards.length, 3);
    },
  );
});

test('a stored Finnhub key switches the plugin to Finnhub and skips Stooq/Yahoo entirely', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async (url) => {
      assert.match(String(url), /finnhub\.io/);
      return jsonResponse(200, { c: 227.5, pc: 226.25 });
    },
    async () => {
      const result = await pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => 'a-finnhub-key' });
      assert.equal(result.cards[0].value, '+0.6%');
    },
  );
});

test('a rejected Finnhub key (401) throws a clear error when a key is configured', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async () => jsonResponse(401, { error: 'unauthorized' }),
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => 'bad-key' }),
        /Finnhub rejected the API key/,
      );
    },
  );
});

test('a network-level failure on every source propagates instead of silently swallowing', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    async () => {
      await assert.rejects(
        () => pollStocks({ settings: { symbols: 'AAPL' }, getSecret: async () => null }),
        /ENOTFOUND/,
      );
    },
  );
});

test('with no symbols setting at all, defaults to AAPL', async (t) => {
  _resetCacheForTests();
  t.after(() => _resetCacheForTests());
  await withMockFetch(
    async () => textResponse(200, STOOQ_AAPL_CSV),
    async () => {
      const result = await pollStocks({ settings: {}, getSecret: async () => null });
      assert.equal(result.cards.length, 1);
      assert.equal(result.cards[0].title, 'AAPL');
    },
  );
});

test('stocks plugin description advertises the keyless default, not a required key', () => {
  assert.doesNotMatch(description, /no key stored/i);
  assert.match(description, /keyless/i);
});

// --- Nexus 281ee5a2 slice 2: onEditValue/onRemoveInstance (layout editor) ---

test('onEditValue replaces the matching slot in place, same index, and reports the new card id', async () => {
  const result = await onEditValue({ settings: { symbols: 'AAPL,TSLA' } }, 'stocks-aapl', 'goog');
  assert.equal(result.settings.symbols, 'GOOG,TSLA');
  assert.equal(result.newCardId, 'stocks-goog');
});

test('onEditValue rejects a symbol that would collide with another configured slot', async () => {
  await assert.rejects(
    () => onEditValue({ settings: { symbols: 'AAPL,TSLA' } }, 'stocks-aapl', 'tsla'),
    /Already tracking/,
  );
});

test('onEditValue throws for a card id that is not one of the configured symbols', async () => {
  await assert.rejects(
    () => onEditValue({ settings: { symbols: 'AAPL,TSLA' } }, 'stocks-goog', 'msft'),
    /isn't one of this feed's configured symbols/,
  );
});

test('onEditValue rejects a blank symbol', async () => {
  await assert.rejects(() => onEditValue({ settings: { symbols: 'AAPL' } }, 'stocks-aapl', '   '), /cannot be blank/);
});

test('onRemoveInstance drops just that symbol and reports not-empty when others remain', async () => {
  const result = await onRemoveInstance({ settings: { symbols: 'AAPL,TSLA' } }, 'stocks-aapl');
  assert.equal(result.settings.symbols, 'TSLA');
  assert.equal(result.empty, false);
});

test('onRemoveInstance reports empty: true once the last symbol is removed', async () => {
  const result = await onRemoveInstance({ settings: { symbols: 'AAPL' } }, 'stocks-aapl');
  assert.equal(result.settings.symbols, '');
  assert.equal(result.empty, true);
});
