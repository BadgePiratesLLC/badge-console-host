// The log file is what makes a failure visible on the two platforms where
// the OS service manager doesn't capture stdout for us (Windows Task
// Scheduler, non-systemd Linux XDG-autostart — see autostart.mjs). Prove
// the file actually gets written, not just that console output happens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-logger-test-'));
setScratchHome(scratch);

const { log } = await import('../src/logger.mjs');
const { LOG_PATH } = await import('../src/paths.mjs');

test('log.info and log.error both land in the log file at LOG_PATH', () => {
  log.info('hello from a test');
  log.error('something went wrong');
  const contents = fs.readFileSync(LOG_PATH, 'utf8');
  assert.match(contents, /\[INFO\].*hello from a test/);
  assert.match(contents, /\[ERROR\].*something went wrong/);
});

test('a failing plugin poll writes its error to the log file', async () => {
  const { PluginRuntime } = await import('../src/plugin-runtime.mjs');
  const failing = {
    id: 'log-test-feed',
    label: 'log-test-feed',
    defaultIntervalSeconds: 60,
    minIntervalSeconds: 1,
    credentialsSchema: [],
    settingsSchema: [],
    async poll() { throw new Error('deliberate log-test failure'); },
  };
  const runtime = new PluginRuntime([failing]);
  await runtime.runOnce('log-test-feed');
  const contents = fs.readFileSync(LOG_PATH, 'utf8');
  assert.match(contents, /\[log-test-feed\] poll failed: deliberate log-test failure/);
});
