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

A plugin may also export `async onAction(ctx, cardId)` if it pushes any
`type: 'button'` cards (see **Button cards**, below) — same `ctx` shape
as `poll()`.

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

## Button cards (Nexus 7c9c1a15, scope addition 2026-11-21)

Add `type: 'button'` to a card to make it tappable instead of passive on
the badge (full wire contract in `docs/CardSchema.md` in the QACode_27
firmware repo). When a buyer taps it, the badge POSTs the card's own
`id` to this host's `/action` endpoint (see `action-server.mjs`) — the
`PluginRuntime` looks up which plugin most recently pushed that id and
calls that plugin's `onAction(ctx, cardId)`.

```js
export async function onAction(ctx, cardId) {
  // ctx.settings / ctx.getSecret(account) — identical to poll()'s ctx.
  // cardId — whatever your own poll() put in that button card's `id`.
  // Throw to report a failure. On success, PluginRuntime re-runs your
  // poll() and pushes its cards right away (Nexus ba0be49a) — this
  // doesn't block the response to the badge, so there's nothing for
  // onAction() itself to return or push; just do the real-world action
  // and let your own poll() reflect the result on its next run.
}
```

`homeassistant.mjs` is the reference implementation: it pushes a state
card (reads one entity) and, if configured, a button card, and its
`onAction()` calls the HA service the buyer configured
(`light.toggle`, a scene, a script — whatever `domain.service` they put
in `actionService`). The badge never talks to HA and never sees the HA
token — it only ever reports "this id got tapped" back to this process.
