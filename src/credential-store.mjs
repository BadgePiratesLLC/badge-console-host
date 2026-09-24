// Credential storage: OS keychain where available, otherwise a 0600 file.
// Never the config page's own storage (config.json holds no secret values,
// only account-name references — see config-store.mjs).
//
// Design constraint from the ticket: no npm dependency for this (native
// keychain bindings like keytar complicate single-binary packaging and add
// an audit surface on a security-sensitive path). Every backend below
// shells out to something the OS already ships.
//
// Known trade-off, documented rather than hidden: on macOS and Linux the
// secret value is passed as a CLI argument to the backend tool, which is
// briefly visible to other local users via `ps`. This mirrors how `security`
// and `secret-tool` are used in most shell tooling; a buyer who needs a
// stronger guarantee should use the file backend's permissions (0600,
// owner-only) as the honest baseline instead.
//
// Every OS-tool invocation below has a hard timeout (BACKEND_TIMEOUT_MS).
// Found the hard way, not guessed: on a real (non-sandboxed) macOS CI
// runner, `security add-generic-password` hung indefinitely instead of
// erroring — it was waiting on a keychain-access confirmation dialog that
// can never appear in a headless session. Without a timeout, that hang
// defeats the entire point of the catch-and-fall-back-to-file design
// below: the code never reaches the catch. See docs/DECISIONS.md.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SECRETS_DIR } from './paths.mjs';

const execFileAsync = promisify(execFile);
const BACKEND_TIMEOUT_MS = 8000;

function fileSlug(service, account) {
  return `${service}__${account}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function secretFilePath(service, account) {
  return path.join(SECRETS_DIR, `${fileSlug(service, account)}.secret`);
}

async function fileSet(service, account, value) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const p = secretFilePath(service, account);
  fs.writeFileSync(p, value, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return { backend: 'file', warning: 'No OS keychain detected — stored in a 0600 file (owner-read-only).' };
}

async function fileGet(service, account) {
  const p = secretFilePath(service, account);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

async function fileDelete(service, account) {
  const p = secretFilePath(service, account);
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

// --- macOS: Keychain via `security` (ships with every Mac) ---

async function macSet(service, account, value) {
  await execFileAsync('security', [
    'add-generic-password', '-a', account, '-s', service, '-w', value, '-U',
  ], { timeout: BACKEND_TIMEOUT_MS });
  return { backend: 'keychain' };
}

async function macGet(service, account) {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password', '-a', account, '-s', service, '-w',
    ], { timeout: BACKEND_TIMEOUT_MS });
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
}

async function macDelete(service, account) {
  try {
    await execFileAsync('security', ['delete-generic-password', '-a', account, '-s', service], { timeout: BACKEND_TIMEOUT_MS });
  } catch { /* already gone */ }
}

// --- Linux: libsecret's `secret-tool`, when installed ---

let _secretToolAvailable;
async function hasSecretTool() {
  if (_secretToolAvailable !== undefined) return _secretToolAvailable;
  try {
    await execFileAsync('which', ['secret-tool'], { timeout: BACKEND_TIMEOUT_MS });
    _secretToolAvailable = true;
  } catch {
    _secretToolAvailable = false;
  }
  return _secretToolAvailable;
}

function execFileWithStdin(cmd, args, input, { timeout = BACKEND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function linuxSet(service, account, value) {
  await execFileWithStdin('secret-tool', [
    'store', '--label', `badge-console-host: ${service}/${account}`,
    'service', service, 'account', account,
  ], value);
  return { backend: 'keychain' };
}

async function linuxGet(service, account) {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', service, 'account', account], { timeout: BACKEND_TIMEOUT_MS });
    return stdout.replace(/\n$/, '') || null;
  } catch {
    return null;
  }
}

async function linuxDelete(service, account) {
  try {
    await execFileAsync('secret-tool', ['clear', 'service', service, 'account', account], { timeout: BACKEND_TIMEOUT_MS });
  } catch { /* already gone */ }
}

// --- Windows: DPAPI (CurrentUser scope) via PowerShell, which ships with
// every supported Windows release. This is not literally Credential
// Manager (cmdkey has no programmatic read path for a stored password) but
// gives the same property that matters here: at rest, encrypted to this
// Windows user account, unreadable by copying the file to another machine
// or account.
//
// The secret is passed to PowerShell via an environment variable set only
// on this one child process, not stdin. (An earlier stdin-based version,
// reading via `[Console]::In.ReadToEnd()`, round-tripped an empty string
// on a real Windows CI runner — stdin redirected through Node's
// execFile is not guaranteed to reach `[Console]::In` the way a directly
// piped terminal would. Env vars set on a specific child process avoid
// that whole class of problem and aren't visible in `ps`/Task Manager's
// command-line column the way an argv value would be.) ---

function psScriptPath() {
  return path.join(os.tmpdir(), `bch-dpapi-${process.pid}-${Date.now()}.ps1`);
}

function runPowerShell(script, envExtra = {}) {
  const scriptPath = psScriptPath();
  fs.writeFileSync(scriptPath, script, 'utf8');
  return execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
    timeout: BACKEND_TIMEOUT_MS,
    env: { ...process.env, ...envExtra },
  }).finally(() => { try { fs.unlinkSync(scriptPath); } catch { /* best effort */ } });
}

async function winSet(service, account, value) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  const p = secretFilePath(service, account);
  const script = [
    '$secure = ConvertTo-SecureString -String $env:BCH_SECRET_VALUE -AsPlainText -Force',
    '$enc = ConvertFrom-SecureString -SecureString $secure',
    `Set-Content -Path "${p.replace(/\\/g, '\\\\')}" -Value $enc -NoNewline`,
  ].join('\n');
  await runPowerShell(script, { BCH_SECRET_VALUE: value });
  return { backend: 'keychain' };
}

async function winGet(service, account) {
  const p = secretFilePath(service, account);
  if (!fs.existsSync(p)) return null;
  const script = [
    `$enc = Get-Content -Path "${p.replace(/\\/g, '\\\\')}" -Raw`,
    '$secure = ConvertTo-SecureString -String $enc',
    '$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    '[System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)',
  ].join('\n');
  try {
    const { stdout } = await runPowerShell(script);
    return stdout.replace(/\r?\n$/, '') || null;
  } catch {
    return null;
  }
}

async function winDelete(service, account) {
  return fileDelete(service, account);
}

function backendFor() {
  if (process.platform === 'darwin') return { set: macSet, get: macGet, del: macDelete, name: 'macOS Keychain' };
  if (process.platform === 'win32') return { set: winSet, get: winGet, del: winDelete, name: 'Windows DPAPI' };
  return null; // linux is checked lazily (secret-tool may or may not be installed)
}

/**
 * Store a secret. Returns { backend: 'keychain'|'file', warning? }.
 * Falls back to the file backend on any keychain-backend failure so a
 * transient keychain problem never silently drops the credential.
 */
export async function setSecret(service, account, value) {
  if (process.platform === 'linux') {
    if (await hasSecretTool()) {
      try { return await linuxSet(service, account, value); }
      catch (e) { return { ...(await fileSet(service, account, value)), warning: `libsecret write failed (${e.message.slice(0, 120)}) — used file fallback.` }; }
    }
    return fileSet(service, account, value);
  }
  const backend = backendFor();
  if (!backend) return fileSet(service, account, value);
  try {
    return await backend.set(service, account, value);
  } catch (e) {
    return { ...(await fileSet(service, account, value)), warning: `${backend.name} write failed (${e.message.slice(0, 120)}) — used file fallback.` };
  }
}

export async function getSecret(service, account) {
  if (process.platform === 'linux') {
    if (await hasSecretTool()) {
      const v = await linuxGet(service, account);
      if (v !== null) return v;
    }
    return fileGet(service, account);
  }
  const backend = backendFor();
  if (!backend) return fileGet(service, account);
  const v = await backend.get(service, account);
  if (v !== null) return v;
  return fileGet(service, account); // covers secrets written before a keychain became available
}

export async function deleteSecret(service, account) {
  if (process.platform === 'linux' && await hasSecretTool()) {
    await linuxDelete(service, account);
  } else {
    const backend = backendFor();
    if (backend) await backend.del(service, account);
  }
  await fileDelete(service, account);
}

export async function hasSecret(service, account) {
  return (await getSecret(service, account)) !== null;
}
