// Nexus b1ad1a04: the app's own "check GitHub Releases, prompt" update
// check. Mocks global.fetch the same way plugins-anthropic-openai.test.mjs
// does — no live GitHub call in CI, just the contract: newer tag → prompt,
// same/older tag → no prompt, request failure → cached state survives and
// nothing throws past the module boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForSelfUpdate } from '../src/self-update-check.mjs';

function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('reports an update when the latest release tag is newer', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/x/releases/tag/v0.2.0' }),
    async () => {
      const result = await checkForSelfUpdate('0.1.7', { force: true });
      assert.equal(result.updateAvailable, true);
      assert.equal(result.latestVersion, '0.2.0');
      assert.equal(result.error, null);
    },
  );
});

test('reports no update when already on the latest tag', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { tag_name: 'v0.1.7' }),
    async () => {
      const result = await checkForSelfUpdate('0.1.7', { force: true });
      assert.equal(result.updateAvailable, false);
    },
  );
});

test('a running version newer than the latest tag is not flagged', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { tag_name: 'v0.1.0' }),
    async () => {
      const result = await checkForSelfUpdate('0.1.7', { force: true });
      assert.equal(result.updateAvailable, false);
    },
  );
});

test('a non-2xx response is captured as an error, not thrown', async () => {
  await withMockFetch(
    async () => jsonResponse(404, {}),
    async () => {
      const result = await checkForSelfUpdate('0.1.7', { force: true });
      assert.equal(result.updateAvailable, false);
      assert.match(result.error, /404/);
    },
  );
});

test('a network failure is captured as an error, not thrown', async () => {
  await withMockFetch(
    async () => { throw new Error('getaddrinfo ENOTFOUND'); },
    async () => {
      const result = await checkForSelfUpdate('0.1.7', { force: true });
      assert.equal(result.updateAvailable, false);
      assert.match(result.error, /ENOTFOUND/);
    },
  );
});
