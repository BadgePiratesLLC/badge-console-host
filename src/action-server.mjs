// The reverse channel for button-type cards (Nexus 7c9c1a15, HA-plugin
// scope addition 2026-11-21). Deliberately a *separate* listener from
// server.mjs's config page: that page binds 127.0.0.1 on purpose and has
// no auth of its own (see server.mjs's header comment) because it holds
// pairing/credential controls. This one has to be reachable by the badge
// over the LAN, so it binds 0.0.0.0 and is gated by the same shared
// AuthToken the badge already requires on its own /cards endpoint — one
// shared secret, checked in both directions, no new credential surface.
//
// Wire contract: POST /action, header X-Auth-Token: <badge token>,
// body {"id": "<card id>"}. 401 on a missing/wrong token, 404 if the id
// isn't a card any plugin currently owns (or that plugin has no
// onAction), 200 on success, 502 if the plugin's onAction() throws.

import http from 'node:http';
import { getBadgeToken } from './badge-client.mjs';
import { log } from './logger.mjs';

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

export function createActionServer(runtime) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://0.0.0.0');
    if (req.method !== 'POST' || url.pathname !== '/action') {
      return sendJson(res, 404, { error: 'not found' });
    }

    const token = await getBadgeToken();
    if (!token || req.headers['x-auth-token'] !== token) {
      return sendJson(res, 401, { error: 'bad or missing X-Auth-Token' });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    if (!body.id || typeof body.id !== 'string') {
      return sendJson(res, 400, { error: 'missing id' });
    }

    try {
      await runtime.handleAction(body.id);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      log.error(`action "${body.id}" failed: ${e.message}`);
      const notFound = /no known card owner|has no onAction/i.test(e.message);
      return sendJson(res, notFound ? 404 : 502, { ok: false, error: e.message });
    }
  });
}

export function start(runtime, port = Number(process.env.BADGE_CONSOLE_ACTION_PORT || 4174)) {
  const server = createActionServer(runtime);
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      log.info(`badge-console-host: action listener at http://0.0.0.0:${port} (for badge button taps)`);
      resolve(server);
    });
  });
}
