import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

// Point the home directory at a scratch dir before importing
// credential-store.mjs (its SECRETS_DIR constant is derived at import time
// via paths.mjs) so this suite never touches a real keychain entry or a
// real file under the actual user's home.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-test-'));
setScratchHome(scratch);

const { setSecret, getSecret, deleteSecret, hasSecret } = await import('../src/credential-store.mjs');

test('set/get/delete round-trip (via whichever backend this OS actually has — keychain or file fallback)', async () => {
  // Every backend that would try a real OS keychain has an 8s timeout and
  // falls back to the file backend on any failure (including a timeout),
  // so this assertion holds regardless of which OS/CI runner this executes
  // on — confirmed the hard way: a real macOS CI runner's `security`
  // hangs waiting on a keychain-access dialog that can never appear
  // headless, and without the timeout this test would hang too.
  const result = await setSecret('bch-test-service', 'unit-test-account', 'sekrit-value');
  assert.ok(result.backend === 'file' || result.backend === 'keychain');

  const got = await getSecret('bch-test-service', 'unit-test-account');
  assert.equal(got, 'sekrit-value');

  assert.equal(await hasSecret('bch-test-service', 'unit-test-account'), true);

  await deleteSecret('bch-test-service', 'unit-test-account');
  assert.equal(await getSecret('bch-test-service', 'unit-test-account'), null);
  assert.equal(await hasSecret('bch-test-service', 'unit-test-account'), false);
});

test('when the file backend is the one actually used, it writes 0600-mode files on POSIX', { skip: process.platform === 'win32' }, async () => {
  const result = await setSecret('bch-test-service', 'mode-check', 'x');
  if (result.backend !== 'file') {
    // A real keychain (or secret-tool) was available and used instead —
    // nothing to assert about file permissions in that case, and forcing
    // the file path here would test a path setSecret didn't actually take.
    await deleteSecret('bch-test-service', 'mode-check');
    return;
  }
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
