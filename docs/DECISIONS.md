# Decisions

Kept here rather than in commit messages so the reasoning survives even
after the commit that made the call is buried in history.

## Not X/Twitter

X/Twitter API access starts near $200/month (per-app, not per-user) as of
2026. The badge sells assembled at ~$45. A feed whose provider cost alone
is 4x the device price is not a v1 feed, full stop — this was true when
Nexus 3a6a69b5 was filed and is the reason the ticket calls it out by name.
**Do not re-propose X/Twitter as a feed without a materially different
pricing tier existing.** If someone asks "what about Twitter", point them
here first.

## Zero npm dependencies

Everything in `src/` uses only Node built-ins (`http`, `dgram`, `fs`,
`child_process`, global `fetch`). `package.json` does have one
`devDependency`, `esbuild` — it only runs inside `scripts/build-sea.mjs`
at build time (to bundle the ESM source to the single CJS file Node's SEA
support requires; see "Single-executable packaging" below) and never
ships inside the resulting binary or anywhere a buyer's own code would
load it. The two reasons below are both about what the *product* depends
on, which this doesn't change:

1. **"It is inspectable, which matters for a security-conscious buyer."**
   A buyer auditing this repo should not also have to audit a bundled
   third-party keychain library or mDNS stack transitively pulled in by an
   npm dependency tree.
2. **Packaging.** Native-binding dependencies (keytar, etc.) are exactly
   the kind of thing that breaks single-executable/cross-compiled builds.
   Shelling out to a CLI the OS already ships (`security`, `secret-tool`,
   `powershell`) sidesteps that class of problem entirely.

The cost of this choice: the OS-keychain integrations (macOS Keychain,
Windows DPAPI, Linux secret-tool) are implemented against each platform's
documented CLI/PowerShell surface but are **untested in this repo's CI**
beyond the file-fallback path, the same honest caveat the firmware repo
(QACode_27, Nexus 7c9c1a15) carries for its own untested-on-hardware
commit. macOS Keychain write access specifically failed in this repo's own
dev sandbox (`security: SecKeychainItemCreateFromContent: Write
permissions error`) because that sandbox has no GUI session/keychain
unlock — which is itself a useful signal: the code's automatic
fall-through to the file backend on any keychain failure (see
`credential-store.mjs`) is exercised for real by that failure, not just by
a test double.

## OpenClaw plugin's data source is a v1 assumption, not a confirmed contract

`src/plugins/openclaw.mjs` reads `~/.openclaw/state/nexus_invocations.jsonl`
— the same log `ops/badge_token_pusher.mjs` (BadgePirates' own internal
desk-console pusher, agent-repo, Nexus 7ea89cbf) already reads for "no API
keys leave this host" token metering. Reusing that path is a real,
production-proven choice, not a guess about the format. What **is** an open
question: does every OpenClaw install write this same log in this same
shape, or is that specific to BadgePirates' own Supabase-backed metering
setup? This plugin deliberately does *not* depend on
`nexus_invocation_metric.mjs`'s billing-cycle-anchor model (that's
BadgePirates-internal infrastructure a generic buyer doesn't have) — it
reports raw local activity (invocations today, invocations in the last
24h, minutes since last activity) instead. **Needs a Kevin/Jared
confirmation pass before v1 ships**: either this generalizes to every
OpenClaw install, or the plugin needs a different local signal.

## Badge discovery: mDNS is written but currently inert

The config page's "find the badge (mDNS or a typed IP)" requirement needs
the *badge* to advertise an mDNS service; as of this repo's first commit,
the QACode_27 firmware (`src/Console/`) does not call `MDNS.begin()` or
advertise any service — confirmed by grep, not inferred. `src/mdns.mjs`
implements a real RFC 6762 PTR/SRV/A/TXT query client (tested against a
hand-built response packet, see `test/mdns.test.mjs`) that will start
finding badges the moment firmware adds a `_badgeconsole._tcp` service
advertisement, with zero host-side changes needed. Until then, typed-IP
pairing is the only path that actually works, and that's the path this
repo's own end-to-end test (`test/server-e2e.test.mjs`) exercises.
**Follow-up needed on the firmware side** (QACode_27, not this repo) to
close this gap — small, additive (`ESPmDNS.h` + `MDNS.begin()` next to
the existing `WebServer` setup), but out of scope for a host-agent commit.

## Real CI findings that changed this repo (2026-09-24)

The first `ci.yml` run against real macOS/Windows/Linux GitHub-hosted
runners (not this dev sandbox) surfaced two real bugs, both fixed the same
day:

1. **No timeout on any OS-keychain subprocess.** On the real macOS
   runner, `security add-generic-password` hung indefinitely — it was
   waiting on a keychain-access confirmation dialog that can never appear
   in a headless CI session, and the job had to be force-cancelled after
   ~90s with an orphaned `security` process still running. This defeated
   the entire "fall back to file on any keychain failure" design, because
   a hang never reaches the `catch`. Fix: every `execFile`/PowerShell call
   in `credential-store.mjs` now has an 8s timeout
   (`BACKEND_TIMEOUT_MS`), so a stuck OS prompt degrades to the file
   backend within 8 seconds instead of hanging the whole host agent.
2. **Windows DPAPI round-trip returned an empty string.** The original
   implementation piped the secret value to PowerShell over stdin,
   decoded inside the script via `[Console]::In.ReadToEnd()`. On a real
   Windows runner this reliably read back `''`, not the value —
   Node's execFile-redirected stdin doesn't reach `[Console]::In` the way
   a real piped terminal does. Fixed by passing the value through an
   environment variable scoped to that one child process
   (`$env:BCH_SECRET_VALUE`) instead, which also avoids putting the
   secret in argv.

The lesson generalized into how this repo's tests use "point HOME at a
scratch dir" as an isolation technique: `os.homedir()` reads `$HOME` on
POSIX but `%USERPROFILE%` on Windows, so a HOME-only override silently
no-ops on the windows-latest runner and every test relying on it sees the
runner's *real* profile instead of the intended scratch one. Tests now go
through `test/_helpers.mjs`'s `setScratchHome()`, which sets both.

**Takeaway for anyone picking this repo back up:** this sandbox's own dev
environment (macOS, no GUI keychain session, only one Node build) could
not have caught either bug — they only showed up on `ci.yml`'s real
runners. Treat local "it passed" here as necessary, not sufficient; watch
the GitHub Actions run for anything platform-specific in this repo before
trusting a change is done.

## Windows credential storage isn't literally Credential Manager

`cmdkey` (Windows Credential Manager's CLI) can *store* a generic
credential but has no documented way to read the password back out
programmatically — by design, Credential Manager expects the *app*
that owns a credential to retrieve it via a Win32 API, not a script. DPAPI
(`ConvertTo-SecureString` / `ConvertFrom-SecureString`, `CurrentUser`
scope, via PowerShell — ships with every supported Windows release) is
used instead: same practical property (encrypted at rest, tied to this
Windows user account, unreadable if the file is copied elsewhere), no
native module, no extra install step. Untested against a real Windows
machine in this repo (dev environment is macOS-only); the GitHub Actions
release workflow's `windows-latest` runner is where this should get its
first real exercise.

## Single-executable packaging: real bugs found, now verified locally too

The note that used to live here said this "could not be exercised
locally" because Homebrew's Node has SEA support stripped, and that first
real verification would have to happen in CI. That was true as far as it
went, but it let two releases (v0.1.1, v0.1.2) ship with a SEA that
crashed on first launch anyway (Nexus bcae3a08, filed by Gilfoyle off a
real GAMINGCRAP install) — "the build step exits 0" and "the binary
actually starts" turned out to be two different claims, and CI before
this fix only checked the first one. Three real bugs, all fixed together:

1. **SEA main was raw ESM.** Node's SEA support only runs a CommonJS
   main; `--experimental-sea-config`'s `main` pointed straight at
   `src/server.mjs` (`type: module`), so every release exe hit `Cannot
   use import statement outside a module` and exited immediately.
   `scripts/build-sea.mjs` now bundles `src/sea-entry.mjs` to a single CJS
   file with esbuild (devDependency only — never shipped, never a
   dependency of the actual product; see "Zero npm dependencies" below)
   before generating the SEA blob.
2. **A SEA doesn't follow imports *or* fs reads out of the one file.**
   Bundling fixes the plugin/module imports, but `web/` (the config
   page's static HTML/JS/CSS, read via `fs` from `__dirname`) was never
   going to be sitting on disk next to a single-file exe. It now rides
   along as embedded SEA `assets` (`web/index.html`, `web/app.js`,
   `web/style.css`), fetched at runtime via `node:sea`'s `getAsset()`
   instead of `fs` when `sea.isSea()` is true (see `server.mjs`'s
   `serveStatic`).
3. **The direct-run guard never matched on Windows, SEA or not.**
   `import.meta.url === \`file://${process.argv[1]}\`` builds a
   malformed URL on Windows (no leading `file:///`, backslashes left raw)
   and `argv[1]` isn't even the running script inside a SEA. Fixed with
   `pathToFileURL(process.argv[1]).href` for the real `node
   src/server.mjs` case, plus a separate `src/sea-entry.mjs` that calls
   the extracted `runCli()` unconditionally for the SEA case, which never
   needs to self-detect at all.

**Locally verified this time**, not just asserted: this dev sandbox's own
Homebrew Node still has SEA stripped, same as before, but a real
nodejs.org-distributed Node 22 binary downloaded straight from
nodejs.org/dist (not npm, not Homebrew) runs the full
`scripts/build-sea.mjs` pipeline end-to-end, and the resulting
`dist/badge-console-host` binary, run standalone, serves `GET
/api/state` (200, real feed list) and `GET /` (200, the actual
`web/index.html`, `/style.css`, `/app.js` — all from embedded SEA assets,
zero files on disk next to the binary) correctly. `.github/workflows/
release.yml`'s build job now also runs `scripts/sea-smoke.mjs` against
the literal artifact it's about to upload, on all three runners, so a
future regression here fails the release build instead of shipping quietly
like v0.1.1/v0.1.2 did.

## Known trade-off: secret values briefly touch argv on macOS/Linux

`security add-generic-password -w <value>` and (best case) `secret-tool`
invocation both put the secret value in the process's command-line
arguments for the life of that short-lived subprocess, visible to other
local users via `ps` in that window. This is standard practice for both
tools (neither documents a stdin-based write path) and is called out here
rather than glossed over. The file-fallback path does not have this
problem (value goes straight to `fs.writeFileSync`), and the Windows path
avoids it by piping over stdin to PowerShell.

## Anthropic/OpenAI plugins: mocked contract tests, not a live key

Nexus d46f4521 asked for these two plugins to satisfy the Phase 0 contract:
throw a clear error on a bad key or provider outage, never emit a blank
card or a fabricated zero. Both `anthropic.mjs` and `openai.mjs` already
existed with that behavior written in, but had zero test coverage — a
comment in `test/plugins-live.test.mjs` claimed they were "contract-tested
via plugin-runtime.test.mjs's fakes," which was never true (that file only
ever runs synthetic `fakePlugin()` objects, not these two modules). Fixed
by adding `test/plugins-anthropic-openai.test.mjs`, which mocks
`global.fetch` to prove: no stored key → throws before any network call;
401/403 → throws a "rejected the key" message; other non-2xx → throws with
the status; a `fetch` rejection (DNS/network failure) propagates instead of
being swallowed; and a successful two-endpoint response sums correctly into
the two expected cards. Also corrected the misleading comment. **What this
still doesn't prove**: whether Anthropic's/OpenAI's real Usage/Costs API
response JSON actually matches the shape `usage.data[].results[]` /
`cost.data[].results[].amount.value` this code assumes — no Admin API key
for either provider was available in this dev environment to check that.
If a real key becomes available, that's the next thing to run against it,
not the error-handling contract (which is now proven).

## Button cards: a second, LAN-bound listener instead of reusing the config server

Nexus 7c9c1a15's 2026-11-21 scope addition ("button cards that CONTROL
Home Assistant") needs the badge to report a tap back to the host. The
config server in `server.mjs` binds `127.0.0.1` deliberately (it holds
pairing/credential controls and has no auth of its own) — reusing it for
badge callbacks would have meant either opening that whole page to the
LAN or bolting an exception onto one route, both worse than a second,
narrow listener. `action-server.mjs` binds `0.0.0.0` on its own port
(`BADGE_CONSOLE_ACTION_PORT`, default 4174), exposes exactly one route
(`POST /action`), and is gated by the same shared `AuthToken` the badge
already requires on its own `/cards` endpoint — one secret, checked both
directions, no new credential surface and no new provisioning step. The
badge learns this port from an `X-Action-Port` header on every `/cards`
push (see `docs/CardSchema.md` "Button cards" in the QACode_27 repo) and
learns the host's IP from the TCP connection that push arrived on — it
never needs to be told a host address separately.

## Pairing moved from "paste the long token" to "type a 6-digit code"

Nexus 2f45b023. The original pairing UI asked a buyer to copy the badge's
32-char hex device token off its Wi-Fi setup portal and paste it into this
config page. That token then also got shown, unredacted, on the badge's
own Cards screen in v2.2.1 (Kevin: *"that code...wtf"*), which settled the
bigger problem: a secret that a person has to read and retype is a secret
that ends up displayed somewhere, sooner or later.

`testPairing(host, port, token)` is gone; `badge-client.mjs` now has
`exchangePairCode(host, port, code)`, which `POST`s a short-lived 6-digit
code to the badge's new `/pair` route and gets the real device token back
in the response. `/api/badge/pair` takes `{ host, port, code }` instead of
`{ host, port, token }` — a breaking API change, intentional, since the
old shape could not express "the server, not the caller, decides the
token." The config page's own "Pair" field changed from "Token" to "Code"
to match.

One thing this does NOT do: verify the exchanged token actually works
against `POST /cards` before storing it (the old `testPairing()` did an
empty-array probe push for exactly that). Not needed anymore — a 200 from
`/pair` already means the badge itself just minted and handed back that
token, so there's nothing left to probe for. `pushCards()` still surfaces
a bad/expired token plainly on the next real push if something ever does
go wrong downstream.

## Stocks plugin: keyless by default, Stooq's named URL verified dead on arrival

Nexus c5941ef2 (Kevin: *"can we not just do a scrap to get stock values?
... no API key and no signup"*). The v1 stocks plugin (Nexus c7aa8e00)
required a Finnhub key before it would even attempt a poll; this ticket
flips the default to free/keyless and keeps Finnhub as an opt-in override
— if a key is stored, every configured symbol uses Finnhub exclusively
instead of the free path, matching the ticket's "optional 'use my own
key'" ask.

**Verified live 2026-11-25, before writing any code against it:** the
exact Stooq URL this ticket named
(`stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcvp&h&e=csv`) 404s from this
network. The real response isn't a data gap or a renamed field — it's a
JS proof-of-work challenge page (`"This site requires JavaScript to
verify your browser"`) in front of `stooq.com/q/d/l/...` too, so this
isn't specific to the quote endpoint. There's no header or key that gets
a plain server-side `fetch` past that. Rather than drop Stooq, it's still
coded as the first attempt in `fetchQuote()` — cheap, still keyless, and
the challenge may differ by network/IP or lift later — with every error
(404, challenge HTML, timeout) falling through to Yahoo's unofficial
`v8/finance/chart` endpoint, confirmed live the same day:
`meta.regularMarketPrice` and `meta.previousClose` are real fields on
that response; there is no `meta.marketState` on it, so market-open/closed
is computed independently (`isMarketOpen()`, a plain America/New_York
9:30-16:00 Mon-Fri check with no holiday calendar) rather than trusted
from the provider. In practice, right now, every poll runs the Yahoo path.

**Poll-interval requirement vs. the existing single-interval scheduler:**
`plugin-runtime.mjs`'s scheduler runs one fixed `setInterval` per feed;
making that market-hours-aware for one plugin would have meant changing
shared scheduling code for every other feed too. Instead `defaultIntervalSeconds`
stays at the market-hours floor (300s) and the plugin self-throttles
inside `poll()`: a per-symbol `nextAllowedFetchAt` map gates whether a
given runtime tick actually hits the network (5 min open, 30 min closed,
and a 15-minute minimum back-off on any 429 from Stooq/Yahoo/Finnhub,
regardless of market hours) — the runtime can tick as often as the buyer
sets it, but the upstream call rate stays bounded.

**"Never blank, show warn when stale" vs. "show closed with last close":**
these are two different tile states and the firmware's `CardState` enum
(`Ok | Warn | Err | Neutral` — confirmed in QACode_27's `CardStore.h`) only
has one spare slot for both, so they can't both be distinct colors by
inventing a new state the badge doesn't know about. Split the meaning
instead: `state: 'warn'` is reserved for "a fetch failed and this number
might be stale," `state: 'neutral'` means "fetch succeeded, market's just
shut, this is the real last close," and `state: 'ok'` means "fresh,
market's open." Up/down day, which the v1 plugin encoded as `ok`/`warn`
(overloading `warn` to mean "red," not "stale"), moved to the icon alone
(`stock-up`/`stock-down`) so `warn` means one thing.

## One-click installers (Nexus b1ad1a04): what they wrap and don't change

Windows (`installer/windows/setup.iss`, Inno Setup), macOS
(`installer/macos/build-dmg.sh`, a hand-built `.app` + `hdiutil`), and Linux
(`installer/linux/build-deb.sh`, `dpkg-deb`) installers all wrap the exact
same `dist/badge-console-host[.exe]` `scripts/build-sea.mjs` already builds
and `scripts/sea-smoke.mjs` already proves starts — none of them rebuild or
re-bundle anything. `.github/workflows/release.yml`'s new
`package-installers` job runs each OS's packaging script on that OS's own
real GitHub-hosted runner, then re-runs `sea-smoke.mjs` against the
*installed* copy (not the raw binary a second time) — the same "build exits
0 isn't the same claim as the artifact starts" discipline the Single-
executable packaging section above describes for Nexus bcae3a08, one layer
up: an installer that unpacks a different file than it tested, or chmods it
wrong, or points a shortcut at the wrong path, would ship a second,
installer-shaped way to recreate that exact bug.

Windows gets a "start at login" checkbox (Inno Setup `[Tasks]`, checked by
default) that — only if left checked — runs the existing, idempotent
`--install-autostart` flag (`src/autostart.mjs`) as a post-install step; no
new autostart mechanism was written for this. macOS and Linux installers
deliberately do **not** auto-register a login item on install (unlike
`install.sh`/`install.ps1`, which already did and still do, unconditionally,
for anyone using the terminal one-liner) — silently adding a login item from
a GUI installer with no visible checkbox is the kind of thing a buyer
notices later and resents; a buyer who wants that on Mac/Linux still has
`--install-autostart` one flag away, or the existing curl path.

## Code signing: cost and options (Nexus b1ad1a04 — spend decision, not mine to make)

Both unsigned installers above will trip a warning on first run, and this
is not a bug to "fix" in code — it's unavoidable without actually paying
for identity verification:

- **Windows:** SmartScreen shows "Windows protected your PC" / "Unrecognized
  app" on an unsigned (or newly-signed, low-reputation) `.exe`, requiring an
  extra "More info → Run anyway" click. Since March 2024, Microsoft builds
  SmartScreen reputation off download volume for **both** OV and EV
  certificates, not EV-only as older guidance claimed — so EV no longer
  buys instant trust the way it once did; it mainly matters now for kernel-
  mode drivers, which this product has none of.
- **macOS:** Gatekeeper refuses to open an app from an "unidentified
  developer" at all (not just a warning) unless the buyer right-clicks →
  Open, or the app is notarized. Our current ad-hoc signing
  (`codesign -s -`, in both `build-sea.mjs` and
  `installer/macos/build-dmg.sh`) avoids the harsher "is damaged and can't
  be opened" failure a *totally* unsigned app can hit on recent macOS, but
  does not clear Gatekeeper's identified-developer bar — that needs a real
  Apple Developer ID.

**Options and real-world cost, 2026 pricing (reseller quotes; get a live
quote before budgeting — these move):**

| Option | Cost | Covers | Notes |
|---|---|---|---|
| Do nothing (current state) | $0 | — | Both OSes show a scary-looking warning; install/install.sh's/.ps1's own users already see this today and it hasn't blocked anyone, but a GUI installer is the first impression for a buyer who isn't comfortable with a terminal |
| **Azure Trusted Signing** (Microsoft, recently renamed "Artifact Signing") | **$9.99/mo (Basic, 5,000 signatures/mo)** | Windows only | Cheapest real option; a Microsoft-issued cert, short-lived (resigned per-build via CI, no hardware token to manage), identity verification required once at signup (business must be ≥3 years old OR have an individual identity-verified enrollment — verify Badge Pirates LLC qualifies before committing) |
| Sectigo OV code signing cert | **~$220/yr** (reseller) to $536/yr (Sectigo direct, 5-yr term) | Windows only | Traditional cert + USB hardware token or cloud HSM slot; annual renewal process, more manual than Trusted Signing |
| DigiCert/Sectigo EV code signing cert | **~$290–$685/yr** | Windows only | No longer buys instant SmartScreen trust (see above) — mainly worth it only if kernel driver signing is ever needed, which it isn't here |
| **Apple Developer Program** | **$99/yr** | macOS only (also unlocks iOS/notarization) | The only way to clear Gatekeeper's "unidentified developer" block short of telling every buyer to right-click → Open; no cheaper tier exists |
| Linux (.deb/AppImage) | $0 | — | No OS-level Gatekeeper/SmartScreen equivalent exists on Linux; nothing to buy here regardless of what's decided for Windows/macOS |

**Recommendation (Jared/Kevin's call, not executed here — nothing was
purchased):** Azure Trusted Signing ($9.99/mo ≈ $120/yr) for Windows plus
the Apple Developer Program ($99/yr) for macOS — **≈$220/yr total** — covers
both desktop OSes a buyer is actually likely to hit the warning on, at the
lowest real cost for each. Skip the OV/EV cert path entirely; it costs more
than Trusted Signing for the same Windows outcome now that EV's SmartScreen
advantage is gone. Nothing on Linux needs a spend.
