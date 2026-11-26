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

// Nexus 7175f3fc item 2: the badge used to have exactly one weather icon
// (sun) and drew nothing at all on a cloudy/rainy/snowy reading — "the
// weather tile has lost its icon" was really "every reading that isn't
// clear has no mapping." CardIcons.cpp now draws four shapes (weather-
// sunny/cloudy/rain/snow); this maps NWS's full condition-code set onto
// those four instead of guessing from the freeform textDescription string
// alone, which varies in wording release to release (and was the whole
// reason a real "Cloudy" reading used to show nothing below).
//
// NWS's `icon` field is a URL like ".../icons/land/day/ovc?size=medium"
// (or ".../day/skc,40?size=medium" for a two-part forecast icon) — the
// last path segment before the query string, day/night prefix aside, is
// the documented condition code (https://api.weather.gov/icons).
const SNOW_CODES = /^(snow|rain_snow|snow_sleet|sleet|blizzard|snow_fzra)/;
const RAIN_CODES = /^(rain|tsra|rain_fzra|fzra)/;
const CLEAR_CODES = /^(skc|few)/; // clear / mostly clear — the only two NWS codes for "sunny"

function iconCodeFromUrl(url) {
  if (!url) return null;
  const seg = url.split('?')[0].split('/').filter(Boolean).pop();
  return seg ? seg.split(',')[0].toLowerCase() : null;
}

function iconForObservation(p) {
  const code = iconCodeFromUrl(p.icon);
  if (code) {
    if (SNOW_CODES.test(code)) return 'weather-snow';
    if (RAIN_CODES.test(code)) return 'weather-rain';
    if (CLEAR_CODES.test(code)) return 'weather-sunny';
    // sct/bkn/ovc/fog/haze/smoke/dust/wind_*/tornado/hurricane/... — none
    // of those are "clear", and the badge only has four shapes to pick
    // from, so everything else reads as "cloudy" rather than "no icon".
    return 'weather-cloudy';
  }
  // Seen live: an occasional observation with both `icon` and
  // `textDescription` blank. Fall back to the description text; if that's
  // blank too, there's genuinely nothing to go on — CardIcon::None is the
  // badge's "no icon, never a crash" sentinel (CardSchema.md), not a bug.
  const text = p.textDescription || '';
  if (/snow|sleet|blizzard/i.test(text)) return 'weather-snow';
  if (/rain|shower|storm|drizzle/i.test(text)) return 'weather-rain';
  if (/clear|sunny|fair/i.test(text)) return 'weather-sunny';
  return text ? 'weather-cloudy' : 'none';
}

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
  const icon = iconForObservation(p);

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
