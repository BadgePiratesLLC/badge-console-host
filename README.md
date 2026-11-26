# badge-console-host

The host half of the BadgePirates desk console badge (CC13, ~150 units
sold assembled + preloaded with the stand). The badge itself is a dumb
renderer — it stores and displays small generic "cards" and nothing else.
This program runs on the buyer's own computer, owns every credential and
every provider quirk, polls whichever feeds they turn on, and pushes cards
to the badge over the local network.

Nexus 3a6a69b5. Depends on the card schema (Nexus 7c9c1a15, QACode_27
`docs/CardSchema.md`), which has landed.

## For a buyer: install

macOS / Linux:
```
curl -fsSL https://raw.githubusercontent.com/BadgePiratesLLC/badge-console-host/main/install/install.sh | sh
```

Windows (PowerShell, no admin needed):
```
iwr https://raw.githubusercontent.com/BadgePiratesLLC/badge-console-host/main/install/install.ps1 -UseBasicParsing | iex
```

That installs a single binary, registers it to start on login, and opens
nothing by itself — go to **http://127.0.0.1:4173** in a browser to pair
your badge and turn on feeds. No terminal needed after the one command
above. *(Releases aren't published yet — see "Status" below.)*

## For a buyer: using it

1. **Pair.** Once the badge is on your Wi-Fi, open its Cards screen and
   press Pair — it shows a one-time 6-digit code, valid for 5 minutes.
   Type the badge's IP (or use "find on network") and that code into the
   config page. The badge's own long-lived device token never has to be
   read or copied by anyone; the config page gets it automatically as
   part of this exchange.
2. **Turn on feeds**, set a poll interval and any per-feed settings
   (ticker symbol, team, location). Each feed that needs a credential has
   a field for it right there — the key goes straight to your OS keychain
   (or a 0600 file if this OS/config doesn't have one), never anywhere
   else.
3. **Watch status.** Each feed shows its last success, last error (in
   plain language), and next scheduled poll. A wrong key shows up here as
   a clear error, not a blank badge card.

## What ships in v1

| Feed | Needs a key | Notes |
|---|---|---|
| Anthropic | yes (Admin API key) | usage + spend today |
| OpenAI | yes (Admin API key) | usage + spend today |
| OpenClaw | no | reads this machine's own local invocation log |
| Stocks | no (Stooq/Yahoo); optional Finnhub key to use that instead | up to 3 symbols, each its own tile |
| Sports | no | one followed team, via ESPN's public scoreboard API |
| Weather | no | current conditions via api.weather.gov (US only) |
| Home Assistant | yes (long-lived access token) | one state card + one optional button card that calls an HA service — see `docs/PLUGINS.md` "Button cards" |

**Not X/Twitter** — API access starts near $200/month, which doesn't fit
a $45 device. See `docs/DECISIONS.md` before re-proposing it.

## Status (2026-11-26, Nexus 281ee5a2 slice 2)

**Since the last status update (Nexus 281ee5a2 slice 1 + the 31f026ef
credential-UI fix, both v0.1.7):**

- The badge-served layout editor (QACode_27's `GET /layout`) can now edit
  a tile in place, not just view it: tap a tile to rename its value
  (stock symbol, team, location, HA entity), recolor it, or delete it.
  This host only ever receives the resulting edit over the existing
  `/action`-style reverse channel — see `docs/PLUGINS.md`'s new
  **Editable tiles** section for the plugin contract
  (`editLabel`/`editValue`/`onEditValue`/`onRemoveInstance`) and
  QACode_27's `docs/CardSchema.md` for the badge-side wire format
  (`remove: true`, `/tile-edit`, `/edit`).
- `stocks.mjs` is the one plugin with real multi-instance removal
  (`onRemoveInstance`) — deleting a symbol tile removes just that symbol,
  not the whole feed. `sports.mjs`/`weather.mjs`/`homeassistant.mjs` are
  single-instance, so deleting their one tile disables the feed; this is
  the documented default for any plugin that doesn't implement
  `onRemoveInstance`.
- `weather.mjs`'s edit field is raw `"lat,lon"` text, not a city/ZIP
  search — geocoding free-text locations is real work the approved
  layout-editor mockup round didn't cover, so this is "edit what the
  setting actually is" until that lands.
- A tile's color override (the edit panel's swatch picker) lives in
  `config-store.mjs`'s new `cardOverrides`, independent of any plugin's
  settings, and is re-applied after every poll so it survives the next
  scheduled push. `PluginRuntime._poll()` also now diffs each poll's card
  ids against the previous one and pushes an explicit removal for
  anything that disappeared (a removed stock symbol, a disabled feed) —
  previously that tile would have just gone stale on the badge forever.
- Covered by 30 new tests across `test/plugin-runtime.test.mjs`,
  `test/action-server.test.mjs`, `test/plugins-stocks.test.mjs`,
  `test/plugins-live.test.mjs` (sports/weather), and
  `test/plugins-homeassistant.test.mjs` (95 total, all green). Also
  verified end-to-end against a mock server + headless Chromium
  (rename, recolor, delete, and the "value field hidden for a
  non-editable card" case) — see that ticket's closing comment for
  screenshots.
- **Not done:** the add-a-tile catalog and drag/reorder (slices 3-4 of
  this same layout editor) — tapping an empty slot or "+ Add" shows a
  "coming in a later update" message rather than doing anything.

## Status (2026-11-26, v0.1.7)

**Since the last status update (Nexus 7175f3fc — desk console 2.3.2):**

- `weather.mjs`'s icon mapping no longer relies on a `textDescription`
  regex that only ever matched "clear" — it now reads NWS's actual
  condition code (the last path segment of the observation's `icon` URL)
  and maps the full code set onto the badge's four weather shapes (sunny/
  cloudy/rain/snow), falling back to the description text only if `icon`
  itself is missing. Previously, any real-world non-clear reading (i.e.
  most of the time) pushed `icon: 'none'` — "the weather tile has lost its
  icon" was a mapping gap, not a regression. Covered by
  `test/plugins-live.test.mjs` (asserts the live card's icon is always one
  of the four, never `none`).
- `sports.mjs` sends ESPN's team short name (`t.name`, e.g. "Chiefs")
  instead of the bare abbreviation ("KC") for the tile title, falling back
  to the abbreviation above 10 characters since this plugin has no way to
  measure the badge's actual pixel width — `CardApp`'s own auto-fit/
  ellipsis on the firmware side is the real safety net for a borderline
  name. Covered by `test/plugins-live.test.mjs`.
- Confirmed, not changed: `plugin-runtime.mjs`'s `_poll()` already clears
  `status.lastError` unconditionally on the next successful push (it did
  before this release too) — the "push to badge failed: fetch failed"
  `lastError` Jared saw on `openai`/`sports`/`weather` right after the
  2.3.1 reboot was the transient it looked like, not a sticky flag. No
  code change; verified with a forced-fail-then-succeed `PluginRuntime`
  run.
- Both changes are to feed plugins only — no `server.mjs`/`action-server.mjs`/
  `plugin-runtime.mjs` wire-format changes. Still needs its usual `git pull`
  + restart on whichever host runs this from source — a tag/release alone
  never reaches a from-source install.

## Status (2026-11-26, Nexus ba0be49a)

**Since the last status update (Nexus ba0be49a — "bookshelf HA button does
nothing when tapped"):**

- The Home Assistant button card no longer shows the literal string `"TAP"`
  for every entity regardless of state. `poll()` now reads the action
  entity's own current state and renders it: `"ON"`/`"OFF"` (bright amber
  vs. dim grey tile) for a plain on/off entity, its raw state uppercased
  for anything else (a cover's `"opening"`, say). Covered by
  `test/plugins-homeassistant.test.mjs`.
- A tap no longer waits for the plugin's own poll interval (up to 60s) to
  show the new state: `PluginRuntime.handleAction()` now fires a fresh
  poll+push immediately after a successful `onAction()`, without blocking
  the HTTP response the badge is waiting on for its own pressed/success/
  fail tile feedback. Covered by `test/plugin-runtime.test.mjs`.
- `action-server.mjs` now logs every `/action` request it receives —
  method+path for anything that doesn't match the route, the remote
  address and outcome for a bad/missing token, a malformed body, a missing
  id, and the handled result — not just a `handleAction()` throw. Jared's
  debugging notes on this ticket found *zero* log lines for any tap,
  successful or not, which this closes: from here on, "no log line at all"
  means the request never reached this listener, not "logging didn't
  cover that case."
- **Not verified against this ticket's real hardware report.** Everything
  above is proven by the mocked-`fetch`/mocked-runtime unit tests listed;
  this dev environment has no network path to the actual House HA
  instance, the actual paired badge, or the Windows machine (pid 31396)
  Kevin's "book shelf button does not work" report named. Whether the
  underlying reason the tap never arrived (open question going into this
  ticket — wrong/stale callback IP, a firewall drop between the badge and
  4174, or something else) is actually fixed can only be confirmed by
  Kevin tapping the real tile and the new logging (this release's,
  `ActionClient`'s Serial trace on the QACode_27 side) showing where in
  the chain it lands. Quote the HA entity's `state` before and after the
  tap, same as Carla's 64644fa0 QA did for the direct-API check, as the
  closing proof.

## Status (2026-11-25)

**Since the last status update:**

- The stocks plugin (Nexus c5941ef2) switched from Finnhub-required to
  keyless by default — Stooq's CSV quote first, Yahoo's unofficial v8
  chart JSON on any Stooq failure, Finnhub only if a key is stored. Up to
  3 symbols, each its own tile. Mocked-`fetch` tests in
  `test/plugins-stocks.test.mjs` cover the fallback chain, the
  market-closed state, the staleness/never-blank contract, and the
  optional-key override. **Verified live, not just mocked:** the exact
  Stooq URL this ticket named currently 404s behind a JS challenge from
  this network (real finding, not a guess — see `docs/DECISIONS.md`), so
  in practice this plugin runs on the Yahoo path today; Yahoo's response
  shape was confirmed live the same day. Not yet verified against a real
  paired badge or from GAMINGCRAP's network (Gilfoyle's deploy, separate
  from this session).

## Status (2026-11-21)

Built and tested end-to-end against a simulated badge (see
`test/server-e2e.test.mjs`) and against the real free/keyless APIs
(weather, sports, this machine's OpenClaw log — see
`test/plugins-live.test.mjs`).

**Verified since the last status update, via real GitHub Actions runners
(this repo's dev sandbox is macOS-only and can't exercise the others
itself):**

- The OS keychain paths — `ci.yml`'s 3-OS matrix passes on real
  ubuntu-latest / windows-latest / macos-latest runners, including the
  Windows DPAPI path (two real bugs found and fixed there — see
  `docs/DECISIONS.md`).
- The single-executable build (`scripts/build-sea.mjs`) on an official
  Node.js build — `release.yml`'s 3-runner matrix now builds a working
  SEA binary on macOS, Linux, *and* Windows (one real bug found and fixed:
  Windows' `npx` isn't directly spawnable without `shell: true`).
- The release actually gets published: `release.yml` now has a
  `publish-release` job (it didn't before) that attaches all three binaries
  to a real GitHub Release under the exact names `install.sh` / `install.ps1`
  expect. Proven with a real `v0.1.0` tag push.
- The Anthropic and OpenAI plugins' error contract (Nexus d46f4521) — a
  missing key, a rejected key, a provider HTTP error, and a raw network
  failure each throw a clear message and never fall through to a card, via
  mocked-`fetch` tests in `test/plugins-anthropic-openai.test.mjs`, plus a
  real `PluginRuntime.runOnce()` check that a missing credential turns into
  `status.lastError` and not a pushed card. What that mocking can't prove is
  whether Anthropic's/OpenAI's actual response JSON matches the shape this
  code assumes — see below.
- The stocks plugin's error contract (Nexus c7aa8e00) — no key, a rejected
  key (401), the free-tier rate limit (429), a provider HTTP error, and an
  unknown-symbol response each throw a clear message instead of a zero,
  via mocked-`fetch` tests in `test/plugins-stocks.test.mjs`. The other
  three v1 feeds this same ticket covers — OpenClaw, Sports, Weather — were
  already live-tested (see `test/plugins-live.test.mjs`) before this
  status update; stocks was the one plugin still missing test coverage.

**2026-11-21 update:** the one-line installers were pointing at a stale
`v0.1.0` release (Sept 24) that predated the Home Assistant plugin,
per-feed display-order UI, and file-backed logging — a buyer running
`install.sh` today would have silently gotten old code. Cut `v0.1.1`
(tag push → `release.yml`'s 3-OS matrix → published), so `latest` now
matches `main`. No other packaging gap changed since Sept 24 — the repo
visibility blocker below still stands.

**Not yet verified:**

- **The repo is private.** `raw.githubusercontent.com` and
  `releases/.../download/...` both 404 for an unauthenticated request
  against a private repo — confirmed live. Every URL in this README's
  "install" section is unreachable by an actual buyer until this repo is
  made public. This is the current #1 blocker on the whole packaging
  phase; making it public is Kevin's call, not this session's.
- Against a real, physical CC13 badge running the card-schema firmware
  (firmware side isn't currently building on GAMINGCRAP — separate
  blocker, see Nexus 7c9c1a15).
- Anthropic/OpenAI plugins against a real Admin API key. The error-handling
  contract is now mocked-fetch tested (see above), but the request/response
  *shape* still just follows each provider's documented Usage/Costs API and
  has never round-tripped against a live account — if either provider's
  actual JSON differs from the docs, the success path could misparse
  without necessarily throwing.
- mDNS badge discovery — the client is real and packet-tested
  (`test/mdns.test.mjs`), but inert until the badge firmware advertises a
  service (it doesn't yet; typed-IP pairing is the path that works today).
- No installer has been run on a genuinely fresh machine end-to-end (and
  can't be, publicly, until the repo is public).

None of that is hidden inside the code — every gap above has a matching
note in `docs/DECISIONS.md` at the point it matters.

## Repo layout

```
src/
  server.mjs           entry point: config web server + poll scheduler
  plugin-runtime.mjs   the plugin contract + scheduler
  credential-store.mjs OS keychain / 0600 file credential storage
  config-store.mjs     non-secret settings (which feeds on, intervals, order)
  badge-client.mjs     POST /cards + pairing
  mdns.mjs             dependency-free mDNS browse client
  autostart.mjs        launchd / systemd / Task Scheduler registration
  plugins/             one file per feed — see docs/PLUGINS.md
  web/                 the config page itself (no build step)
docs/
  DECISIONS.md         why things are built the way they are
  PLUGINS.md           how to add a feed
scripts/build-sea.mjs  single-executable build
install/               one-line installers per OS
.github/workflows/     CI + release binary builds
```

## Development

```
npm test        # node --test — 17 tests, ~0.6s, no network required
                 #   except the two live-API tests (weather, sports)
npm start        # runs the config page at http://127.0.0.1:4173
```

Zero npm dependencies by design — see `docs/DECISIONS.md`.
