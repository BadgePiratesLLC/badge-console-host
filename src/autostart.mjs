// "Starts on login, quiet by default" — one function per OS, each
// using only what that OS already ships (launchd on macOS, Task
// Scheduler's `schtasks` on Windows, a systemd --user unit on Linux with
// an XDG autostart .desktop fallback for non-systemd desktops). No
// installer framework, no code signing requirement, nothing beyond what's
// already on the machine.
//
// Idempotent: re-running overwrites the previous entry rather than
// erroring or duplicating it, so it's safe to call on every `--install`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LABEL = 'tech.badgepirates.badge-console-host';

function binaryInvocation() {
  // Prefer the packaged single-file binary if this process *is* one
  // (see scripts/build-sea.mjs); otherwise fall back to `node <entry>`
  // so autostart also works from a plain `npm start` dev checkout.
  const isPkgBuild = process.env.BCH_SEA_BUILD === '1';
  if (isPkgBuild) return { command: process.execPath, args: [] };
  const entry = path.join(path.dirname(new URL(import.meta.url).pathname), 'server.mjs');
  return { command: process.execPath, args: [entry] };
}

async function installMac() {
  const { command, args } = binaryInvocation();
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${command}</string>
    ${args.map((a) => `<string>${a}</string>`).join('\n    ')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${os.homedir()}/.badge-console-host/host-agent.log</string>
  <key>StandardErrorPath</key><string>${os.homedir()}/.badge-console-host/host-agent.log</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  // Reload so a re-run picks up a changed binary path.
  await execFileAsync('launchctl', ['unload', plistPath]).catch(() => {});
  await execFileAsync('launchctl', ['load', plistPath]);
  return { method: 'launchd', path: plistPath };
}

async function installLinux() {
  const { command, args } = binaryInvocation();
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'badge-console-host.service');
  const hasSystemd = fs.existsSync('/run/systemd/system');
  if (hasSystemd) {
    const unit = `[Unit]
Description=Badge Console Host

[Service]
ExecStart=${command} ${args.join(' ')}
Restart=on-failure

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unitPath, unit);
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
    await execFileAsync('systemctl', ['--user', 'enable', '--now', 'badge-console-host.service']);
    return { method: 'systemd --user', path: unitPath };
  }
  // XDG autostart fallback for desktop environments without systemd --user
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopPath = path.join(autostartDir, 'badge-console-host.desktop');
  const desktop = `[Desktop Entry]
Type=Application
Name=Badge Console Host
Exec=${command} ${args.join(' ')}
X-GNOME-Autostart-enabled=true
`;
  fs.mkdirSync(autostartDir, { recursive: true });
  fs.writeFileSync(desktopPath, desktop);
  return { method: 'XDG autostart', path: desktopPath };
}

async function installWindows() {
  const { command, args } = binaryInvocation();
  const taskName = 'BadgeConsoleHost';
  const argStr = args.map((a) => `"${a}"`).join(' ');
  // schtasks ships with every supported Windows release; ONLOGON quiet-starts
  // without an elevated prompt when scoped to the current user.
  await execFileAsync('schtasks', [
    '/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName,
    '/TR', `"${command}" ${argStr}`,
  ]);
  return { method: 'Task Scheduler (schtasks)', path: taskName };
}

export async function installAutostart() {
  if (process.platform === 'darwin') return installMac();
  if (process.platform === 'linux') return installLinux();
  if (process.platform === 'win32') return installWindows();
  throw new Error(`No autostart method implemented for platform "${process.platform}".`);
}
