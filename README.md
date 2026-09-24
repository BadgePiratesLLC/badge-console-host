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

**Not X/Twitter** — API access starts near $200/month, which doesn't fit
a $45 device. See `docs/DECISIONS.md` before re-proposing it.

## Status (2026-09-24)

Built and tested end-to-end against a simulated badge (see
`test/server-e2e.test.mjs`) and against the real free/keyless APIs
(weather, sports, this machine's OpenClaw log — see
`test/plugins-live.test.mjs`). **Not yet verified**:

- Against a real, physical CC13 badge running the card-schema firmware.
- Anthropic/OpenAI plugins against a real Admin API key (request shape
  follows each provider's documented Usage/Costs API; untested live).
- The OS keychain paths on Windows (DPAPI) and Linux (`secret-tool`) —
  code-complete against each platform's documented CLI, untested on real
  Windows/Linux hardware (this repo's dev environment is macOS-only, and
  even macOS Keychain writes failed in *this* sandboxed dev session for
  lack of a GUI-unlocked session — see `docs/DECISIONS.md`).
- The single-executable build (`scripts/build-sea.mjs`) on an official
  Node.js build — only exercised (partially, and unsuccessfully) against
  a Homebrew Node build that ships with SEA support compiled out. First
  real verification should be `.github/workflows/release.yml`'s own run.
- mDNS badge discovery — the client is real and packet-tested
  (`test/mdns.test.mjs`), but inert until the badge firmware advertises a
  service (it doesn't yet; typed-IP pairing is the path that works today).
- No installer has been run on a genuinely fresh machine end-to-end.

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
