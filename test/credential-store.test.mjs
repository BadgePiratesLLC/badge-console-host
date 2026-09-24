import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Force the file-fallback path deterministically in CI/sandbox by pointing
// HOME at a scratch dir before importing paths.mjs (module-level consts).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-test-'));
process.env.HOME = scratch;

const { setSecret, getSecret, deleteSecret, hasSecret } = await import('../src/credential-store.mjs');

test('file fallback: set/get/delete round-trip', async () => {
  // Neither macOS Keychain (no GUI session here) nor secret-tool exist in
  // this sandbox, and win32 code never runs on darwin/linux, so real CI on
  // a Mac/Linux runner without a keychain exercises exactly the file path
  // this test wants to prove.
  const result = await setSecret('bch-test-service', 'unit-test-account', 'sekrit-value');
  assert.ok(result.backend === 'file' || result.backend === 'keychain');

  const got = await getSecret('bch-test-service', 'unit-test-account');
  assert.equal(got, 'sekrit-value');

  assert.equal(await hasSecret('bch-test-service', 'unit-test-account'), true);

  await deleteSecret('bch-test-service', 'unit-test-account');
  assert.equal(await getSecret('bch-test-service', 'unit-test-account'), null);
  assert.equal(await hasSecret('bch-test-service', 'unit-test-account'), false);
});

test('file fallback writes 0600-mode files on POSIX', { skip: process.platform === 'win32' }, async () => {
  await setSecret('bch-test-service', 'mode-check', 'x');
  const secretsDir = path.join(scratch, '.badge-console-host', 'secrets');
  const files = fs.readdirSync(secretsDir).filter((f) => f.includes('mode-check'));
  assert.equal(files.length, 1);
  const stat = fs.statSync(path.join(secretsDir, files[0]));
  assert.equal(stat.mode & 0o777, 0o600);
  await deleteSecret('bch-test-service', 'mode-check');
});

test('getSecret returns null for a never-stored account', async () => {
  assert.equal(await getSecret('bch-test-service', 'never-stored'), null);
});
