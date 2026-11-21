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

1. **Pair.** Power on the badge, put it in Wi-Fi setup mode, and its
   portal page shows a one-time token. Type the badge's IP (or use "find
   on network") and paste the token into the config page.
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
| Stocks | yes (Finnhub, free tier) | one symbol; free tier is 60 calls/min, enforced |
| Sports | no | one followed team, via ESPN's public scoreboard API |
| Weather | no | current conditions via api.weather.gov (US only) |
| Home Assistant | yes (long-lived access token) | one state card + one optional button card that calls an HA service — see `docs/PLUGINS.md` "Button cards" |

**Not X/Twitter** — API access starts near $200/month, which doesn't fit
a $45 device. See `docs/DECISIONS.md` before re-proposing it.

## Status (2026-09-24)

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
