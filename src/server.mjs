#!/usr/bin/env node
// Entry point: starts the feed poller and the local config web page on
// 127.0.0.1. Deliberately not 0.0.0.0 — the config page holds
// pairing/credential controls and has no auth of its own, so it must never
// be reachable off this machine. See docs/DECISIONS.md.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sea from 'node:sea';
import { loadConfig, saveConfig, updateConfig, getFeedConfig } from './config-store.mjs';
import { setSecret, deleteSecret, hasSecret } from './credential-store.mjs';
import { exchangePairCode, setBadgeToken, getOtaStatus, checkBadgeForUpdate, triggerBadgeUpdate } from './badge-client.mjs';
import { browse as mdnsBrowse } from './mdns.mjs';
import { PluginRuntime } from './plugin-runtime.mjs';
import { start as startActionServer } from './action-server.mjs';
import { log } from './logger.mjs';

import * as openclaw from './plugins/openclaw.mjs';
import * as anthropic from './plugins/anthropic.mjs';
import * as openai from './plugins/openai.mjs';
import * as stocks from './plugins/stocks.mjs';
import * as sports from './plugins/sports.mjs';
import * as weather from './plugins/weather.mjs';
import * as homeassistant from './plugins/homeassistant.mjs';

// esbuild empties out import.meta (see scripts/build-sea.mjs) when
// bundling this file to CJS for the SEA build, so fileURLToPath(undefined)
// would throw at module-load time there. __dirname/WEB_DIR are only ever
// consulted by serveStatic()'s non-SEA fallback branch, which the SEA
// build never reaches (sea.isSea() is true there) — the catch just needs
// to not throw, not produce a meaningful path, for that build.
let __dirname;
try {
  __dirname = path.dirname(fileURLToPath(import.meta.url));
} catch {
  __dirname = process.cwd();
}
const WEB_DIR = path.join(__dirname, 'web');
const SERVICE = 'badge-console-host';
const ACTION_PORT = Number(process.env.BADGE_CONSOLE_ACTION_PORT || 4174);

const PLUGINS = [openclaw, anthropic, openai, stocks, sports, weather, homeassistant];
export const runtime = new PluginRuntime(PLUGINS, { actionPort: ACTION_PORT });

let actionServer = null;

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) { res.writeHead(403); res.end(); return true; }
  const ext = path.extname(rel);

  // A SEA binary doesn't have web/ sitting on disk next to it (a SEA
  // doesn't follow fs reads out of the single file any more than it
  // follows imports) — scripts/build-sea.mjs embeds these as SEA assets
  // instead, so serve from there when running as one.
  if (sea.isSea()) {
    let data;
    try { data = sea.getAsset(`web/${rel}`); } catch { return false; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(Buffer.from(data));
    return true;
  }

  const filePath = path.join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return true; }
  if (!fs.existsSync(filePath)) return false;
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handleApi(req, res, pathname) {
  // --- Plugins / feeds ---
  if (pathname === '/api/state' && req.method === 'GET') {
    const cfg = loadConfig();
    const plugins = runtime.listPlugins();
    const status = runtime.getStatus();
    const withCreds = [];
    for (const p of plugins) {
      const feedCfg = getFeedConfig(p.id, { intervalSeconds: p.defaultIntervalSeconds });
      const credState = {};
      for (const cred of p.credentialsSchema) credState[cred.account] = await hasSecret(SERVICE, cred.account);
      withCreds.push({ ...p, config: feedCfg, status: status[p.id], credentials: credState });
    }
    return sendJson(res, 200, { feeds: withCreds, badge: { host: cfg.badge.host, port: cfg.badge.port, paired: cfg.badge.paired } });
  }

  if (pathname.match(/^\/api\/feeds\/[\w-]+$/) && req.method === 'POST') {
    const feedId = pathname.split('/').pop();
    const plugin = PLUGINS.find((p) => p.id === feedId);
    if (!plugin) return sendJson(res, 404, { error: 'no such feed' });
    const body = await readJsonBody(req);
    updateConfig((cfg) => {
      const feedCfg = getFeedConfig(feedId, { intervalSeconds: plugin.defaultIntervalSeconds });
      if (typeof body.enabled === 'boolean') feedCfg.enabled = body.enabled;
      if (typeof body.intervalSeconds === 'number') {
        feedCfg.intervalSeconds = Math.max(plugin.minIntervalSeconds || 1, body.intervalSeconds);
      }
      if (typeof body.order === 'number') feedCfg.order = body.order;
      if (body.settings && typeof body.settings === 'object') {
        feedCfg.settings = { ...feedCfg.settings, ...body.settings };
      }
      cfg.feeds[feedId] = feedCfg;
    });
    runtime.reschedule();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname.match(/^\/api\/feeds\/[\w-]+\/test$/) && req.method === 'POST') {
    const feedId = pathname.split('/')[3];
    try {
      const result = await runtime.runOnce(feedId);
      return sendJson(res, result.ok ? 200 : 502, result);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname.match(/^\/api\/feeds\/[\w-]+\/credential$/) && req.method === 'POST') {
    const feedId = pathname.split('/')[3];
    const plugin = PLUGINS.find((p) => p.id === feedId);
    if (!plugin) return sendJson(res, 404, { error: 'no such feed' });
    const body = await readJsonBody(req);
    if (!body.account || !plugin.credentialsSchema.some((c) => c.account === body.account)) {
      return sendJson(res, 400, { error: 'unknown credential account for this feed' });
    }
    if (typeof body.value !== 'string' || body.value.length === 0) {
      return sendJson(res, 400, { error: 'missing value' });
    }
    const result = await setSecret(SERVICE, body.account, body.value);
    return sendJson(res, 200, result);
  }

  if (pathname.match(/^\/api\/feeds\/[\w-]+\/credential$/) && req.method === 'DELETE') {
    const feedId = pathname.split('/')[3];
    const plugin = PLUGINS.find((p) => p.id === feedId);
    if (!plugin) return sendJson(res, 404, { error: 'no such feed' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const account = url.searchParams.get('account');
    if (!account || !plugin.credentialsSchema.some((c) => c.account === account)) {
      return sendJson(res, 400, { error: 'unknown credential account for this feed' });
    }
    await deleteSecret(SERVICE, account);
    return sendJson(res, 200, { ok: true });
  }

  // --- Badge pairing ---
  if (pathname === '/api/badge/discover' && req.method === 'GET') {
    const results = await mdnsBrowse('_badgeconsole._tcp.local', { timeoutMs: 3000 });
    return sendJson(res, 200, { results });
  }

  if (pathname === '/api/badge/pair' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { host, port, code } = body;
    if (!host || !code) return sendJson(res, 400, { error: 'host and code are required' });
    const exchange = await exchangePairCode(host, port || 80, code);
    if (!exchange.ok) {
      log.error(`Pairing with ${host}:${port || 80} failed: ${exchange.reason}`);
      return sendJson(res, 502, { ok: false, error: exchange.reason });
    }
    await setBadgeToken(exchange.token);
    updateConfig((cfg) => {
      cfg.badge = { host, port: port || 80, paired: true };
    });
    runtime.reschedule();
    log.info(`Paired with badge at ${host}:${port || 80}.`);
    return sendJson(res, 200, { ok: true });
  }

  // --- Badge OTA (Nexus ad98fbf6) — remote "check/apply update now" for
  // the one paired badge, token-gated the same way /cards is (see
  // badge-client.mjs). Jared: "ends Kevin power-cycling for every
  // release." ---
  if (pathname === '/api/badge/ota-status' && req.method === 'GET') {
    const cfg = loadConfig();
    if (!cfg.badge.paired) return sendJson(res, 409, { error: 'badge is not paired yet' });
    try {
      const status = await getOtaStatus(cfg.badge.host, cfg.badge.port);
      return sendJson(res, 200, status);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (pathname === '/api/badge/ota-check' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.badge.paired) return sendJson(res, 409, { error: 'badge is not paired yet' });
    try {
      const result = await checkBadgeForUpdate(cfg.badge.host, cfg.badge.port);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (pathname === '/api/badge/ota-update' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.badge.paired) return sendJson(res, 409, { error: 'badge is not paired yet' });
    try {
      const result = await triggerBadgeUpdate(cfg.badge.host, cfg.badge.port);
      log.info(`Badge OTA update triggered for ${cfg.badge.host}:${cfg.badge.port}.${result.restarted ? ' (badge restarted mid-response)' : ''}`);
      return sendJson(res, 200, result);
    } catch (e) {
      log.error(`Badge OTA update failed for ${cfg.badge.host}:${cfg.badge.port}: ${e.message}`);
      return sendJson(res, 502, { ok: false, error: e.message });
    }
  }

  return null; // not an API route
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, url.pathname);
      if (handled === null) sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      log.error(`Unhandled error on ${req.method} ${url.pathname}: ${e.stack || e.message}`);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (!serveStatic(req, res, url.pathname)) {
    res.writeHead(404);
    res.end('not found');
  }
});

export function start(port = Number(process.env.BADGE_CONSOLE_HOST_PORT || 4173)) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', async () => {
      runtime.start();
      actionServer = await startActionServer(runtime, ACTION_PORT);
      log.info(`badge-console-host: config page at http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

export function stop() {
  runtime.stop();
  return Promise.all([
    new Promise((resolve) => server.close(resolve)),
    actionServer ? new Promise((resolve) => actionServer.close(resolve)) : Promise.resolve(),
  ]);
}

export async function runCli() {
  if (process.argv.includes('--install-autostart')) {
    const { installAutostart } = await import('./autostart.mjs');
    return installAutostart()
      .then((r) => log.info(`Autostart installed via ${r.method} (${r.path}).`))
      .catch((e) => { log.error(`Autostart install failed: ${e.message}`); process.exitCode = 1; });
  }
  return start();
}

// `import.meta.url === \`file://${process.argv[1]}\`` (the original check
// here) never matches on Windows — a file:// URL needs file:///C:/... with
// forward slashes, not the raw backslashed path Windows hands back in
// argv[1] — so plain `node src/server.mjs` never actually started on
// Windows even outside a SEA. pathToFileURL() builds the URL the correct,
// platform-aware way instead of string-concatenating it.
//
// This also never matches inside a SEA, since argv[1] there isn't this
// script's path at all — intentional, not a gap: scripts/build-sea.mjs
// points the SEA at a separate src/sea-entry.mjs that calls runCli()
// unconditionally.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
