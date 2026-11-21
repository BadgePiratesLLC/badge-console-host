// Live network tests against real, free, keyless endpoints (NWS weather,
// ESPN scores) plus a real-shaped OpenClaw log — the three plugins in this
// repo that need no credential and so can be proven for real rather than
// mocked. Anthropic and OpenAI are mocked-fetch contract-tested instead, in
// plugins-anthropic-openai.test.mjs (plugin-runtime.test.mjs never touches
// these two modules — it only exercises synthetic fakePlugin() objects);
// stocks is mocked-fetch contract-tested the same way, in
// plugins-stocks.test.mjs (Nexus c7aa8e00). Verifying anthropic/openai
// against a real Admin API key needs a paid key this dev environment
// doesn't have (see each plugin's file header) and remains untested live.
//
// The openclaw test seeds its own log under a scratch HOME rather than
// reading whatever machine happens to run this suite — a CI runner has no
// `~/.openclaw` at all, and this suite must pass identically there and on
// a dev box that does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setScratchHome } from './_helpers.mjs';

const { poll: pollWeather } = await import('../src/plugins/weather.mjs');
const { poll: pollSports } = await import('../src/plugins/sports.mjs');

test('weather plugin returns a real current-conditions card for a US location', { timeout: 15000 }, async () => {
  const result = await pollWeather({ settings: { lat: '39.0997', lon: '-94.5786' }, getSecret: async () => null });
  assert.equal(result.cards.length, 1);
  const card = result.cards[0];
  assert.equal(card.id, 'weather-current');
  assert.equal(typeof card.value, 'number');
  assert.ok(card.value > -60 && card.value < 140, `temp ${card.value}°F should be a plausible real reading`);
  assert.ok(card.subtitle.length > 0);
});

test('sports plugin returns a real team record card', { timeout: 15000 }, async () => {
  const result = await pollSports({ settings: { sport: 'football/nfl', team: 'KC' }, getSecret: async () => null });
  assert.equal(result.cards.length, 1);
  const card = result.cards[0];
  assert.equal(card.id, 'sports-kc');
  assert.match(card.value, /^\d+-\d+$/, 'record should look like "W-L"');
});

test('sports plugin surfaces an error (not a zero) for a bogus team', { timeout: 15000 }, async () => {
  // ESPN's bogus-team response shape has drifted over time: it has returned
  // a 404/400 (caught explicitly) and, as of this test's last update, a 200
  // with no `.team` field (caught by the generic "no team data" fallback).
  // Either way the plugin contract — throw, never fall through to a zero
  // card — holds; this regex covers both known response shapes.
  await assert.rejects(
    () => pollSports({ settings: { sport: 'football/nfl', team: 'ZZZZZ-not-a-team' }, getSecret: async () => null }),
    /ESPN has no team|ESPN response had no team data/,
  );
});

test('openclaw plugin reads a real-shaped local invocation log', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-openclaw-test-'));
  const restoreHome = setScratchHome(scratch);
  try {
    const stateDir = path.join(scratch, '.openclaw', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'nexus_invocations.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), host: 'ci-runner', pid: 1, script: 'test', calls: 5 })}\n`,
    );
    // Re-imported after the home dir changes so the plugin's
    // homedir()-derived LOG_PATH constant picks up the scratch dir.
    const { poll: pollOpenClaw } = await import(`../src/plugins/openclaw.mjs?t=${Date.now()}`);
    const result = await pollOpenClaw({ settings: {}, getSecret: async () => null });
    assert.equal(result.cards.length, 2);
    assert.equal(result.cards[0].id, 'openclaw-activity');
    assert.equal(result.cards[0].value, 1);
  } finally {
    restoreHome();
  }
});

test('openclaw plugin errors (not a zero) when no log exists', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bch-openclaw-empty-test-'));
  const restoreHome = setScratchHome(scratch);
  try {
    const { poll: pollOpenClaw } = await import(`../src/plugins/openclaw.mjs?t=${Date.now()}`);
    await assert.rejects(() => pollOpenClaw({ settings: {}, getSecret: async () => null }), /No OpenClaw local invocation log/);
  } finally {
    restoreHome();
  }
});
