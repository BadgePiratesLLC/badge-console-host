// Single-team score follow via ESPN's public site API
// (site.api.espn.com/apis/site/v2/sports/...). No key, no signup —
// this is the same unofficial-but-widely-relied-on endpoint countless
// hobby scoreboards use; ESPN has never published a formal free-tier
// contract for it (unlike NWS or Finnhub), which is the honest caveat to
// carry forward here: it can change shape without notice, more likely
// than the other two free feeds in this repo. Verified live during
// development against the NFL's Kansas City Chiefs (see docs/DECISIONS.md).

export const id = 'sports';
export const label = 'Team score';
export const description = 'Next/last game and current record for one followed team, via ESPN’s public scoreboard API (unofficial — no published SLA).';
export const defaultIntervalSeconds = 300;
export const minIntervalSeconds = 60;
export const needsCredentials = [];
export const settingsSchema = [
  { key: 'sport', label: 'Sport path (e.g. football/nfl, basketball/nba)', type: 'text', default: 'football/nfl' },
  { key: 'team', label: 'Team abbreviation (e.g. KC, LAL)', type: 'text', default: 'KC' },
];

export async function poll(ctx) {
  const sport = ctx.settings.sport || 'football/nfl';
  const team = (ctx.settings.team || 'KC').toLowerCase();
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/teams/${encodeURIComponent(team)}`;

  const res = await fetch(url);
  if (res.status === 404 || res.status === 400) {
    throw new Error(`ESPN has no team "${team}" under sport "${sport}" — check both settings.`);
  }
  if (!res.ok) {
    throw new Error(`ESPN scoreboard returned HTTP ${res.status}.`);
  }
  const j = await res.json();
  const t = j.team;
  if (!t) throw new Error('ESPN response had no team data.');

  const event = t.nextEvent?.[0];
  const comp = event?.competitions?.[0];
  const record = t.record?.items?.find((i) => i.type === 'total')?.summary || '—';

  let subtitle = 'no upcoming game found';
  let state = 'neutral';
  if (comp) {
    const status = comp.status?.type;
    const home = comp.competitors?.find((c) => c.homeAway === 'home');
    const away = comp.competitors?.find((c) => c.homeAway === 'away');
    if (status?.state === 'in') {
      subtitle = `${away?.team?.abbreviation} ${away?.score} – ${home?.score} ${home?.team?.abbreviation} (${status.shortDetail})`;
      state = 'ok';
    } else if (status?.state === 'post') {
      subtitle = `Final: ${away?.team?.abbreviation} ${away?.score} – ${home?.score} ${home?.team?.abbreviation}`;
      state = 'neutral';
    } else {
      subtitle = `${away?.team?.abbreviation} @ ${home?.team?.abbreviation}, ${status?.shortDetail || 'scheduled'}`;
      state = 'neutral';
    }
  }

  const now = Date.now();
  return {
    cards: [
      {
        id: `sports-${team}`,
        title: t.abbreviation || team.toUpperCase(),
        value: record,
        unit: '',
        subtitle,
        state,
        updatedAt: now,
        ttlSeconds: 1800,
      },
    ],
  };
}
