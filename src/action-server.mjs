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

// Logged unconditionally at every stage below, success or failure (Nexus
// ba0be49a: "no host log file was found to show whether a tap ever
// arrived" — the prior version only logged a throw from runtime.handleAction,
// so a wrong token, a malformed body, or a request that never arrived at
// all left zero trace to tell those cases apart). remoteAddress is the IP
// the badge actually connected from, straight off the socket — the same
// value a `netstat`/firewall-log cross-check on the Windows side would see.
export function createActionServer(runtime) {
  return http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress;
    const url = new URL(req.url, 'http://0.0.0.0');
    if (req.method !== 'POST' || url.pathname !== '/action') {
      log.info(`action listener: ignored ${req.method} ${url.pathname} from ${remote}`);
      return sendJson(res, 404, { error: 'not found' });
    }

    const token = await getBadgeToken();
    if (!token || req.headers['x-auth-token'] !== token) {
      log.info(`action request from ${remote} rejected: bad or missing X-Auth-Token`);
      return sendJson(res, 401, { error: 'bad or missing X-Auth-Token' });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      log.info(`action request from ${remote} rejected: bad json body`);
      return sendJson(res, 400, { error: 'bad json' });
    }
    if (!body.id || typeof body.id !== 'string') {
      log.info(`action request from ${remote} rejected: missing id`);
      return sendJson(res, 400, { error: 'missing id' });
    }

    log.info(`action request from ${remote}: id "${body.id}" received`);
    try {
      await runtime.handleAction(body.id);
      log.info(`action "${body.id}" from ${remote}: ok`);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      log.error(`action "${body.id}" from ${remote}: failed: ${e.message}`);
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
