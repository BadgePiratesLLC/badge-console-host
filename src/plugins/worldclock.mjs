// World clock — Kevin's own words (Nexus 281ee5a2, 2026-11-26 08:35 CT):
// "Maybe even add a time card to be able to add different timezones."
// The one feed type in this repo that touches no network at all: a tile
// is just today's date/time rendered through Intl in a named IANA zone,
// so poll() can never fail the way every other plugin's network call can.
//
// Storage mirrors stocks' `stock-symbols` convention (Nexus 281ee5a2
// slice 4, c5941ef2) — one comma-joined settings string holding city
// KEYS (not display labels) from CITY_TABLE below, so a stored config
// survives this table growing or a label changing wording later.

export const id = 'worldclock';
export const label = 'World clock';
export const description = 'Local time and day offset for cities around the world — no network, no key.';
export const defaultIntervalSeconds = 60;
export const minIntervalSeconds = 20;
export const credentialsSchema = [];
export const settingsSchema = [
  // type intentionally plain 'text' (not a dedicated list type like
  // stocks' 'stock-symbols') — the host web Feeds page just needs to not
  // crash on this field; the designed add/edit surface for this feed is
  // the badge-served layout editor's "+ Add"/tap-to-edit flow.
  { key: 'cities', label: 'Cities (comma-separated)', type: 'text', default: 'new-york' },
];

// key -> { label, tz, aliases }. IANA zone names, not UTC offsets — these
// track DST automatically, which a fixed offset would not.
const CITY_TABLE = [
  { key: 'new-york', label: 'New York', tz: 'America/New_York', aliases: ['nyc', 'ny'] },
  { key: 'los-angeles', label: 'Los Angeles', tz: 'America/Los_Angeles', aliases: ['la'] },
  { key: 'chicago', label: 'Chicago', tz: 'America/Chicago', aliases: [] },
  { key: 'kansas-city', label: 'Kansas City', tz: 'America/Chicago', aliases: ['kc'] },
  { key: 'denver', label: 'Denver', tz: 'America/Denver', aliases: [] },
  { key: 'toronto', label: 'Toronto', tz: 'America/Toronto', aliases: [] },
  { key: 'mexico-city', label: 'Mexico City', tz: 'America/Mexico_City', aliases: ['cdmx'] },
  { key: 'sao-paulo', label: 'Sao Paulo', tz: 'America/Sao_Paulo', aliases: [] },
  { key: 'buenos-aires', label: 'Buenos Aires', tz: 'America/Argentina/Buenos_Aires', aliases: [] },
  { key: 'honolulu', label: 'Honolulu', tz: 'Pacific/Honolulu', aliases: ['hawaii'] },
  { key: 'anchorage', label: 'Anchorage', tz: 'America/Anchorage', aliases: [] },
  { key: 'london', label: 'London', tz: 'Europe/London', aliases: ['uk'] },
  { key: 'dublin', label: 'Dublin', tz: 'Europe/Dublin', aliases: [] },
  { key: 'paris', label: 'Paris', tz: 'Europe/Paris', aliases: [] },
  { key: 'amsterdam', label: 'Amsterdam', tz: 'Europe/Amsterdam', aliases: [] },
  { key: 'berlin', label: 'Berlin', tz: 'Europe/Berlin', aliases: ['germany'] },
  { key: 'zurich', label: 'Zurich', tz: 'Europe/Zurich', aliases: [] },
  { key: 'madrid', label: 'Madrid', tz: 'Europe/Madrid', aliases: [] },
  { key: 'rome', label: 'Rome', tz: 'Europe/Rome', aliases: [] },
  { key: 'athens', label: 'Athens', tz: 'Europe/Athens', aliases: [] },
  { key: 'istanbul', label: 'Istanbul', tz: 'Europe/Istanbul', aliases: [] },
  { key: 'moscow', label: 'Moscow', tz: 'Europe/Moscow', aliases: [] },
  { key: 'cairo', label: 'Cairo', tz: 'Africa/Cairo', aliases: [] },
  { key: 'johannesburg', label: 'Johannesburg', tz: 'Africa/Johannesburg', aliases: [] },
  { key: 'dubai', label: 'Dubai', tz: 'Asia/Dubai', aliases: ['uae'] },
  { key: 'mumbai', label: 'Mumbai', tz: 'Asia/Kolkata', aliases: ['bombay'] },
  { key: 'delhi', label: 'Delhi', tz: 'Asia/Kolkata', aliases: ['new-delhi'] },
  { key: 'bangkok', label: 'Bangkok', tz: 'Asia/Bangkok', aliases: [] },
  { key: 'singapore', label: 'Singapore', tz: 'Asia/Singapore', aliases: [] },
  { key: 'hong-kong', label: 'Hong Kong', tz: 'Asia/Hong_Kong', aliases: [] },
  { key: 'shanghai', label: 'Shanghai', tz: 'Asia/Shanghai', aliases: [] },
  { key: 'beijing', label: 'Beijing', tz: 'Asia/Shanghai', aliases: [] },
  { key: 'seoul', label: 'Seoul', tz: 'Asia/Seoul', aliases: [] },
  { key: 'tokyo', label: 'Tokyo', tz: 'Asia/Tokyo', aliases: ['japan'] },
  { key: 'sydney', label: 'Sydney', tz: 'Australia/Sydney', aliases: [] },
  { key: 'auckland', label: 'Auckland', tz: 'Pacific/Auckland', aliases: ['new-zealand', 'nz'] },
];

const MAX_CITIES = 3;

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function findCity(query) {
  const needle = normalize(query);
  if (!needle) return null;
  return CITY_TABLE.find((c) => c.key === needle || c.label.toLowerCase() === query.trim().toLowerCase() || c.aliases.includes(needle)) || null;
}

function parseCityKeys(settings) {
  return String(settings?.cities ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function addCardValue(settings, value) {
  const keys = parseCityKeys(settings);
  const city = findCity(value);
  if (!city) throw new Error(`Don't recognize "${value}" — try a bigger nearby city.`);
  if (keys.length >= MAX_CITIES) throw new Error(`Already have ${MAX_CITIES} cities (max) — remove one first.`);
  if (keys.includes(city.key)) throw new Error(`${city.label} is already added.`);
  return { ...settings, cities: [...keys, city.key].join(',') };
}

function findKeyIndex(settings, cardId) {
  const keys = parseCityKeys(settings);
  const idx = keys.findIndex((k) => `worldclock-${k}` === cardId);
  return { keys, idx };
}

export function removeCardValue(settings, cardId) {
  const { keys, idx } = findKeyIndex(settings, cardId);
  if (idx < 0) return null;
  return { ...settings, cities: keys.filter((_, j) => j !== idx).join(',') };
}

// Local system timezone of the host machine — the reference "today" that
// each city's day offset is reported relative to (whatever machine runs
// badge-console-host, which is the same machine Kevin's own clock is on).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function dateOnlyUtcMs(y, m, d) {
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

function zonedParts(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .formatToParts(date)
    .reduce((m, p) => ((m[p.type] = p.value), m), {});
}

function buildCard(city, now, order) {
  const parts = zonedParts(now, city.tz);
  const localParts = zonedParts(now, LOCAL_TZ);
  const dayOffset = Math.round(
    (dateOnlyUtcMs(parts.year, parts.month, parts.day) - dateOnlyUtcMs(localParts.year, localParts.month, localParts.day)) / 86400000,
  );
  const subtitle = dayOffset === 0 ? 'today' : dayOffset > 0 ? `+${dayOffset} day` : `${dayOffset} day`;

  return {
    id: `worldclock-${city.key}`,
    title: city.label,
    value: `${parts.hour}:${parts.minute}`,
    unit: ` ${(parts.dayPeriod || '').toUpperCase()}`,
    subtitle,
    state: 'ok',
    icon: 'clock',
    color: '#2E86C1',
    order,
    updatedAt: Date.now(),
    ttlSeconds: 120,
  };
}

export async function poll(ctx) {
  const keys = parseCityKeys(ctx.settings);
  if (keys.length === 0) throw new Error('No cities configured.');
  const now = new Date();
  const errors = [];
  const cards = [];
  keys.forEach((key, index) => {
    const city = CITY_TABLE.find((c) => c.key === key);
    if (!city) {
      errors.push(`Unknown city key "${key}"`);
      return;
    }
    cards.push(buildCard(city, now, index));
  });
  if (cards.length === 0) throw new Error(errors.join('; ') || 'No valid cities configured.');
  return { cards };
}
