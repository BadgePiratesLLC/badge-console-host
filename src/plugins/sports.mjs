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
export const credentialsSchema = [];
export const settingsSchema = [
  { key: 'sport', label: 'Sport path (e.g. football/nfl, basketball/nba)', type: 'text', default: 'football/nfl' },
  { key: 'team', label: 'Team abbreviation (e.g. KC, LAL)', type: 'text', default: 'KC' },
];

// "2026-11-29T18:00Z" -> "Sun 12:00" (mockup's next-game format) — day
// abbreviation + local clock time, no date-library dependency for one call
// site.
function formatNextGame(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${days[d.getDay()]} ${hh}:${mm}`;
}

// Picks our side out of a completed game's two competitors by abbreviation
// match, and formats "W 24-17" / "L 17-24" (Nexus 365ba2c6: the tile's main
// value was the season record, "the last result" ticket AC means W/L + our
// score first, not raw away-home order).
function formatResult(home, away, abbr) {
  const us = home?.team?.abbreviation === abbr ? home : away;
  const opp = us === home ? away : home;
  // ESPN's `score` field has shipped both as a plain number/string and as
  // `{ value, displayValue }` (the shape it drifted to live during this
  // repo's development) — accept either rather than silently NaN-ing out.
  const usScore = Number(us?.score?.value ?? us?.score ?? 0);
  const oppScore = Number(opp?.score?.value ?? opp?.score ?? 0);
  const letter = usScore > oppScore ? 'W' : usScore < oppScore ? 'L' : 'T';
  return { value: `${letter} ${usScore}-${oppScore}`, opponent: opp?.team?.abbreviation };
}

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
  const abbr = t.abbreviation || team.toUpperCase();

  // Nexus 7175f3fc item 6: "KC" told Kevin nothing at a glance without
  // already knowing it means the Chiefs — ESPN's team-summary response
  // carries the actual name (t.team.name, e.g. "Chiefs") this endpoint was
  // already fetching, just never used. The badge can't measure pixel width
  // (it only sees whatever string this sends), so this falls back to the
  // abbreviation above a conservative character count instead of a true
  // fit check — CardApp's own auto-fit/ellipsis (fitTitleText()) is still
  // there as a safety net if a borderline name still doesn't fit.
  const MAX_SHORT_NAME_LEN = 10;
  const shortName = (t.name || '').toUpperCase();
  const abbrUpper = abbr.toUpperCase();
  const teamLabel = shortName && shortName.length <= MAX_SHORT_NAME_LEN ? shortName : abbrUpper;

  let title = teamLabel;
  // Nexus 365ba2c6: the tile's main value used to be the season record
  // ("8-2") year-round — the ticket's ask is live score / next game / last
  // result there instead, with the record demoted to the detail view
  // (subtitle, shown in CardApp's detail body under the big value).
  let value = '—';
  let subtitle = `no upcoming game found • ${record}`;
  let state = 'neutral';

  if (comp) {
    const status = comp.status?.type;
    const home = comp.competitors?.find((c) => c.homeAway === 'home');
    const away = comp.competitors?.find((c) => c.homeAway === 'away');
    if (status?.state === 'in') {
      const { value: resultValue } = formatResult(home, away, abbr);
      value = resultValue.replace(/^[WLT] /, ''); // score only — game isn't decided yet
      title = `${teamLabel} ${status.period ? `Q${status.period}` : 'LIVE'}`;
      subtitle = `${away?.team?.abbreviation} @ ${home?.team?.abbreviation} (${status.shortDetail}) • ${record}`;
      state = 'ok';
    } else if (status?.state === 'post') {
      const { value: resultValue, opponent } = formatResult(home, away, abbr);
      value = resultValue;
      subtitle = `Final vs ${opponent || '?'} • ${record}`;
      state = 'neutral';
    } else {
      value = formatNextGame(event?.date) || record;
      subtitle = `${away?.team?.abbreviation} @ ${home?.team?.abbreviation}, ${status?.shortDetail || 'scheduled'} • ${record}`;
      state = 'neutral';
    }
  } else {
    // No upcoming game in the team-summary endpoint's nextEvent — ticket
    // AC (Nexus 4ea60fad): "shows the next game or last score ... never
    // blank". Fall back to the most recently completed game from the
    // team's schedule rather than leaving this reading "no game" forever
    // during a bye week or the off-season. A failed/empty fallback just
    // keeps the "no upcoming game found" wording above — not worth
    // failing the whole poll over a secondary lookup.
    try {
      const schedRes = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${sport}/teams/${encodeURIComponent(team)}/schedule`,
      );
      if (schedRes.ok) {
        const sched = await schedRes.json();
        const completed = (sched.events || []).filter(
          (e) => e.competitions?.[0]?.status?.type?.state === 'post',
        );
        const lastComp = completed[completed.length - 1]?.competitions?.[0];
        if (lastComp) {
          const home = lastComp.competitors?.find((c) => c.homeAway === 'home');
          const away = lastComp.competitors?.find((c) => c.homeAway === 'away');
          const { value: resultValue, opponent } = formatResult(home, away, abbr);
          value = resultValue;
          subtitle = `Final vs ${opponent || '?'} • ${record}`;
        }
      }
    } catch {
      // keep the "no upcoming game found" fallback set above
    }
  }

  const now = Date.now();
  return {
    cards: [
      {
        id: `sports-${team}`,
        title,
        value,
        unit: '',
        subtitle,
        state,
        icon: 'football',
        color: '#D6333F',
        order: 1,
        updatedAt: now,
        ttlSeconds: 1800,
      },
    ],
  };
}
