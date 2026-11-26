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
as `poll()`. It may also export `async onEditValue(ctx, cardId, newValue)`
and/or `async onRemoveInstance(ctx, cardId)` for the layout editor's
tap-to-edit panel (see **Editable tiles**, below).

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
  editLabel: 'Symbol',        // optional, see "Editable tiles" below
  editValue: 'AAPL',          // optional, see "Editable tiles" below
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

## Editable tiles (Nexus 281ee5a2 slice 2, scope addition 2026-11-26)

The badge-served layout editor (`GET /layout`, QACode_27's
`data/layout.html`) lets a buyer tap a tile to rename, recolor, or delete
it. Color and delete work for every card automatically (see below); a
card's *value* (a stock symbol, a followed team, a location, an HA entity
id) is only editable if your plugin sets `editLabel`/`editValue` on it and
exports `onEditValue`:

```js
// Set on every card whose primary value a buyer should be able to
// retype from the layout editor. Both or neither — editLabel is the
// panel's field label, editValue is the raw value to prefill (distinct
// from `value`, which is the *formatted display* number).
{ ...card, editLabel: 'Symbol', editValue: symbol }

export async function onEditValue(ctx, cardId, newValue) {
  // Validate newValue, compute this feed's new settings object, and
  // return it — PluginRuntime persists it and re-polls/pushes for you,
  // the same way a button tap's onAction() does.
  // If this card's id is derived from its value (most are — stocks'
  // id is `stocks-<symbol>`), return newCardId too, so the runtime can
  // carry the card's position and any color override forward to it.
  return { settings: { ...ctx.settings, symbol: newValue }, newCardId: `my-feed-${newValue}` };
  // Throw instead for a bad value (blank, duplicate, doesn't parse) —
  // same contract as poll()'s "throw, don't push a lie" rule.
}
```

No `onEditValue` just means that card's edit panel offers color + delete
only, no text field — the layout page never guesses a label from the
card's id or icon.

**Delete** has two shapes, picked automatically by what your plugin
exports:

- No `onRemoveInstance`: your plugin is single-instance (one card, or a
  fixed small set like Home Assistant's state+button pair) — deleting any
  one of its tiles disables the whole feed. This is the default; most
  plugins don't need to do anything for this to work correctly.
- `async onRemoveInstance(ctx, cardId) -> { settings, empty? }`: for a
  plugin that can host more than one instance of itself (stocks today —
  up to 3 symbol tiles from one feed). Remove just that instance from
  your settings and return the result; set `empty: true` if none are left,
  which tells the runtime to disable the feed rather than leave it
  polling nothing. `stocks.mjs` is the reference implementation.

Either way, you never need to tell the badge to remove a stale tile
yourself — `PluginRuntime` diffs each poll's card ids against the
previous one and pushes an explicit `{"id", "remove": true}` (see
`docs/CardSchema.md`'s **Remove** section in QACode_27) for anything that
disappeared, and does the same explicitly when a whole feed gets disabled
this way.

A card's **color** override (the swatch picker in the edit panel) is
handled entirely by the runtime — it's stored per card id in
`config-store.mjs`'s `cardOverrides`, independent of any plugin's
settings, and reapplied after every poll. No plugin code is needed for
this to work; it works identically whether or not your plugin implements
`onEditValue`/`onRemoveInstance`.
