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
`child_process`, global `fetch`). Two reasons, both from the ticket
directly:

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

## Single-executable packaging: verified approach, unverified locally

`scripts/build-sea.mjs` follows Node's documented Single Executable
Application flow (`--experimental-sea-config` + `postject` injection),
which is what every current SEA tutorial and `.github/workflows/release.yml`
target. **This could not be exercised locally**: this repo's dev sandbox
only has Homebrew's Node 26.7.0 build available, and that build reports
"Single executable application is disabled" for *both* the classic
`--experimental-sea-config` flag and the newer Node 26 `--build-sea` flag
— Homebrew's formula appears to compile Node with SEA support stripped,
a packaging choice on Homebrew's side, not a bug in this script. Official
nodejs.org-distributed builds (which is what `actions/setup-node` installs
in CI, and what most buyers who don't use Homebrew would have) do support
it. **First real verification of `scripts/build-sea.mjs` should happen in
CI** (`.github/workflows/release.yml`'s 3-runner matrix), not by trusting
this note — check the workflow's own run history before assuming this
works.

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
