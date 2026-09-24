#!/usr/bin/env node
// Entry point: starts the feed poller and the local config web page on
// 127.0.0.1. Deliberately not 0.0.0.0 — the config page holds
// pairing/credential controls and has no auth of its own, so it must never
// be reachable off this machine. See docs/DECISIONS.md.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, updateConfig, getFeedConfig } from './config-store.mjs';
import { setSecret, deleteSecret, hasSecret } from './credential-store.mjs';
import { testPairing, setBadgeToken } from './badge-client.mjs';
import { browse as mdnsBrowse } from './mdns.mjs';
import { PluginRuntime } from './plugin-runtime.mjs';
import { log } from './logger.mjs';

import * as openclaw from './plugins/openclaw.mjs';
import * as anthropic from './plugins/anthropic.mjs';
import * as openai from './plugins/openai.mjs';
import * as stocks from './plugins/stocks.mjs';
import * as sports from './plugins/sports.mjs';
import * as weather from './plugins/weather.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');
const SERVICE = 'badge-console-host';

const PLUGINS = [openclaw, anthropic, openai, stocks, sports, weather];
export const runtime = new PluginRuntime(PLUGINS);

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
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return true; }
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
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
      for (const account of p.needsCredentials) credState[account] = await hasSecret(SERVICE, account);
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
    if (!body.account || !plugin.needsCredentials.includes(body.account)) {
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
    if (!account || !plugin.needsCredentials.includes(account)) {
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
    const { host, port, token } = body;
    if (!host || !token) return sendJson(res, 400, { error: 'host and token are required' });
    const test = await testPairing(host, port || 80, token);
    if (!test.ok) {
      log.error(`Pairing with ${host}:${port || 80} failed: ${test.reason}`);
      return sendJson(res, 502, { ok: false, error: test.reason });
    }
    await setBadgeToken(token);
    updateConfig((cfg) => {
      cfg.badge = { host, port: port || 80, paired: true };
    });
    runtime.reschedule();
    log.info(`Paired with badge at ${host}:${port || 80}.`);
    return sendJson(res, 200, { ok: true });
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
    server.listen(port, '127.0.0.1', () => {
      runtime.start();
      log.info(`badge-console-host: config page at http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

export function stop() {
  runtime.stop();
  return new Promise((resolve) => server.close(resolve));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--install-autostart')) {
    const { installAutostart } = await import('./autostart.mjs');
    installAutostart()
      .then((r) => log.info(`Autostart installed via ${r.method} (${r.path}).`))
      .catch((e) => { log.error(`Autostart install failed: ${e.message}`); process.exitCode = 1; });
  } else {
    start();
  }
}
