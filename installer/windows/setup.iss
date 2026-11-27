; Nexus b1ad1a04: real Windows installer (vs. the curl|iex-and-a-raw-.exe path
; install/install.ps1 already covers for anyone comfortable with PowerShell).
; Wraps the already-crash-fixed SEA binary (Nexus bcae3a08 — see
; docs/DECISIONS.md "Single-executable packaging"; this installer does not
; change what ships, only how it's delivered) in a Start Menu entry, an
; optional "start at login" checkbox, and opens the config page once
; installed.
;
; Built with Inno Setup's ISCC.exe, which ships pre-installed on GitHub's
; windows-latest runner image (confirmed via actions/runner-images'
; windows-latest software manifest) — no extra install step in CI. The
; release.yml workflow passes BchVersion and BchSourceExe on the command
; line (/DBchVersion=... /DBchSourceExe=...); the defaults below are only
; for a manual local build on a real Windows box.

#ifndef BchVersion
#define BchVersion "0.0.0-dev"
#endif
#ifndef BchSourceExe
#define BchSourceExe "..\..\dist\badge-console-host.exe"
#endif

[Setup]
AppId={{DFD8F601-4EFF-5144-BAFC-7DFBB59F02BB}}
AppName=Badge Console Host
AppVersion={#BchVersion}
AppPublisher=Badge Pirates LLC
AppPublisherURL=https://badgepirates.com
DefaultDirName={autopf}\Badge Console Host
DefaultGroupName=Badge Console Host
UninstallDisplayIcon={app}\badge-console-host.exe
OutputDir=..\..\dist
OutputBaseFilename=badge-console-host-Setup
Compression=lzma
SolidCompression=yes
; Per-user install, no admin prompt — matches the rest of this product's
; "no sudo/no admin needed" stance (install/install.sh, install/install.ps1).
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
; No digital signature yet — see docs/DECISIONS.md "Code signing" for the
; cost/options writeup (Nexus b1ad1a04). SmartScreen will warn on first run
; until that's resolved; this is expected, not a build defect.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startatlogin"; Description: "Start Badge Console Host automatically when I log in"; Flags: checkedonce

[Files]
Source: "{#BchSourceExe}"; DestDir: "{app}"; DestName: "badge-console-host.exe"; Flags: ignoreversion

[Icons]
Name: "{group}\Badge Console Host"; Filename: "{app}\badge-console-host.exe"
Name: "{group}\Badge Console Host Config Page"; Filename: "http://127.0.0.1:4173"
Name: "{group}\Uninstall Badge Console Host"; Filename: "{uninstallexe}"

[Run]
; Registers the Task Scheduler autostart entry (src/autostart.mjs's
; installWindows(), the same idempotent path/the-command-line install
; already uses) only if the checkbox above was left checked.
Filename: "{app}\badge-console-host.exe"; Parameters: "--install-autostart"; Tasks: "startatlogin"; Flags: runhidden waituntilterminated
; Starts the app now and opens the config page in the default browser —
; "opens the config page" per the ticket. A short ping-based wait stands in
; for a fixed sleep: the server binds almost immediately, but a fixed delay
; on a loaded CI/VM runner is exactly the kind of flake this avoids.
Filename: "{app}\badge-console-host.exe"; Description: "Start Badge Console Host now"; Flags: nowait postinstall skipifsilent
Filename: "{cmd}"; Parameters: "/c ping 127.0.0.1 -n 2 >nul && start http://127.0.0.1:4173"; Flags: runhidden nowait postinstall skipifsilent
