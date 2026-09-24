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
