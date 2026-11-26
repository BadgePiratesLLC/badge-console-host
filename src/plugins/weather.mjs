// Current conditions via the National Weather Service API
// (api.weather.gov) — free, no key, US-coverage only. Verified live
// during development for a Kansas City lat/lon: points -> nearest
// observation station -> latest observation. NWS requires a descriptive
// User-Agent identifying the app (not an API key, just good citizenship
// per their docs) — set below with a placeholder contact that should
// become the real product contact before this ships.

export const id = 'weather';
export const label = 'Weather';
export const description = 'Current conditions from the National Weather Service — free, no key, US locations only.';
export const defaultIntervalSeconds = 600;
export const minIntervalSeconds = 120;
export const credentialsSchema = [];
export const settingsSchema = [
  { key: 'lat', label: 'Latitude', type: 'text', default: '39.0997' },
  { key: 'lon', label: 'Longitude', type: 'text', default: '-94.5786' },
];

const USER_AGENT = 'badge-console-host (https://github.com/BadgePiratesLLC/badge-console-host)';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`NWS returned HTTP ${res.status} for ${url}`);
  return res.json();
}

const stationCache = new Map(); // "lat,lon" -> stationId

export async function poll(ctx) {
  const lat = ctx.settings.lat || '39.0997';
  const lon = ctx.settings.lon || '-94.5786';
  const cacheKey = `${lat},${lon}`;

  let stationId = stationCache.get(cacheKey);
  if (!stationId) {
    const point = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`);
    const stationsUrl = point.properties?.observationStations;
    if (!stationsUrl) throw new Error('NWS points lookup had no observationStations link — check lat/lon is within the US.');
    const stations = await fetchJson(stationsUrl);
    stationId = stations.features?.[0]?.id?.split('/').pop();
    if (!stationId) throw new Error('NWS returned no observation stations near this location.');
    stationCache.set(cacheKey, stationId);
  }

  const obs = await fetchJson(`https://api.weather.gov/stations/${stationId}/observations/latest`);
  const p = obs.properties;
  if (!p || p.temperature?.value == null) {
    throw new Error(`Nearest station (${stationId}) has no recent observation.`);
  }
  const tempF = Math.round((p.temperature.value * 9) / 5 + 32);
  // Only the one weather icon the badge draws (CardIcons.cpp) actually
  // exists today — showing it on a rainy/cloudy reading would be a wrong
  // icon, not a missing one, so this only fires on an actually-clear
  // description. CardIcon::None (the default) just means no icon, never a
  // crash — see CardSchema.md.
  const icon = /clear|sunny|fair/i.test(p.textDescription || '') ? 'weather-sunny' : 'none';

  const now = Date.now();
  return {
    cards: [
      {
        id: 'weather-current',
        title: 'KC Weather',
        value: tempF,
        unit: '°F',
        subtitle: p.textDescription || '',
        state: 'neutral',
        icon,
        color: '#1BA8C7',
        order: 0,
        updatedAt: now,
        ttlSeconds: 1800,
      },
    ],
  };
}
