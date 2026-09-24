# Writing a feed plugin

A plugin is one file under `src/plugins/` that exports:

```js
export const id = 'my-feed';                 // stable, used as the config key
export const label = 'My Feed';               // shown on the config page
export const description = '...';             // one line, shown under the label
export const defaultIntervalSeconds = 300;     // starting poll interval
export const minIntervalSeconds = 60;          // floor the config page enforces
export const needsCredentials = ['my-api-key']; // credential-store account names, or []
export const settingsSchema = [                // non-secret per-feed settings, or []
  { key: 'symbol', label: 'Ticker symbol', type: 'text', default: 'AAPL' },
];

export async function poll(ctx) {
  // ctx.settings      — this feed's settingsSchema values, current config
  // ctx.getSecret(account) — async, returns the stored credential or null

  // ... do the work ...

  return { cards: [ /* one or more Card objects, see below */ ] };
}
```

Then import and register it in `src/server.mjs`'s `PLUGINS` array.

## The one rule

**Resolve with cards, or throw.** There is no third option.

- Resolving with `{ cards: [...] }` pushes those cards to the badge and
  marks the feed's status as a success.
- Throwing (or returning a rejected promise) marks the feed as errored,
  with your `Error`'s `message` shown verbatim on the config page, and
  pushes **nothing** — whatever card is already on the badge for this
  feed's id(s) stays as-is and starts aging toward its `ttlSeconds`.

Never resolve with an empty/zero card to represent "I don't have data
right now" — that is a lie the config page and the badge can't tell apart
from "the real value is zero." Throw instead, with a message a buyer can
act on (what's wrong, and if possible, what to check).

## Card shape

Matches the badge firmware's wire contract exactly (`docs/CardSchema.md`
in the QACode_27 repo is the source of truth; this is a summary):

```js
{
  id: 'my-feed-primary',   // stable per card; re-using an id replaces that card
  title: 'My Feed',
  value: 42,                // string or number
  unit: '%',                 // optional
  subtitle: 'as of just now', // optional
  state: 'ok' | 'warn' | 'err' | 'neutral',
  trend: [1, 2, 3],           // optional sparkline, 2+ points
  updatedAt: Date.now(),      // informational only, badge doesn't use it for aging
  ttlSeconds: 300,            // how long until the badge greys this card out
}
```

Pick `ttlSeconds` a little more than your poll interval (some slack), so a
temporarily-down host or provider reads as "aging" on the badge before it
reads as "stuck."

## Credentials

Never read an API key from anywhere but `ctx.getSecret(account)`. Never
log it, never put it in a card, never write it to `config-store.mjs`
(that file is non-secret settings only). The buyer enters it once on the
config page; storage/OS-keychain routing is handled for you.
