// OpenClaw local invocation feed. No credential — reads a log OpenClaw
// itself already writes on this machine, the same source
// ops/badge_token_pusher.mjs (BadgePirates' own internal desk-console
// pusher, Nexus 7ea89cbf) uses for the "no API keys leave this host"
// property. This plugin deliberately does NOT depend on that internal
// script or on BadgePirates' own Supabase billing-cycle model — a generic
// buyer running OpenClaw has the log file but not that infrastructure, so
// v1 reports raw local activity (invocation count, last-active time)
// rather than a "% of my quota" figure.
//
// Open product question, not resolved by this commit: does every OpenClaw
// install write to this same path in this same shape? This repo assumes
// yes (mirrors the one production consumer of this log that exists today)
// but that assumption is worth Kevin/Jared confirming before v1 ships,
// since a path or format drift here fails this plugin's only "no
// credential" feed. See docs/DECISIONS.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const id = 'openclaw';
export const label = 'OpenClaw activity';
export const description = 'Local invocation count from this machine’s own OpenClaw log. No credential, no network call.';
export const defaultIntervalSeconds = 60;
export const minIntervalSeconds = 15;
export const needsCredentials = [];
export const settingsSchema = [];

const LOG_PATH = path.join(os.homedir(), '.openclaw', 'state', 'nexus_invocations.jsonl');

function parseLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn append, don't fail the whole read */ }
  }
  return out;
}

function rowTimestampMs(row) {
  const t = row.ts || row.timestamp || row.at;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export async function poll() {
  let raw;
  try {
    raw = fs.readFileSync(LOG_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`No OpenClaw local invocation log at ${LOG_PATH} — is OpenClaw installed and has it run at least once on this machine?`);
    }
    throw new Error(`Could not read ${LOG_PATH}: ${e.message}`);
  }
  const rows = parseLines(raw);
  if (rows.length === 0) {
    throw new Error(`${LOG_PATH} exists but has no readable invocation rows yet.`);
  }
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let todayCount = 0;
  let last24hCount = 0;
  let lastAtMs = null;
  for (const row of rows) {
    const ms = rowTimestampMs(row);
    if (ms === null) continue;
    if (lastAtMs === null || ms > lastAtMs) lastAtMs = ms;
    if (now - ms <= dayMs) last24hCount++;
    const d = new Date(ms);
    const today = new Date(now);
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
      todayCount++;
    }
  }
  const minutesSinceLast = lastAtMs === null ? null : Math.round((now - lastAtMs) / 60000);
  return {
    cards: [
      {
        id: 'openclaw-activity',
        title: 'OpenClaw',
        value: todayCount,
        unit: 'today',
        subtitle: minutesSinceLast === null ? 'no timestamped rows yet' : `last active ${minutesSinceLast}m ago`,
        state: 'neutral',
        trend: null,
        updatedAt: now,
        ttlSeconds: 600,
      },
      {
        id: 'openclaw-24h',
        title: 'OpenClaw 24h',
        value: last24hCount,
        unit: 'invocations',
        subtitle: `host: ${os.hostname()}`,
        state: 'neutral',
        updatedAt: now,
        ttlSeconds: 600,
      },
    ],
  };
}
