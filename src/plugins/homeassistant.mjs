// Home Assistant — the first plugin that uses a `type: 'button'` card
// (Nexus 7c9c1a15, scope addition 2026-11-21: "button cards that CONTROL
// Home Assistant ... and info cards that SHOW HA state"). This plugin
// owns both halves: poll() returns a state card (reads one entity) and,
// if configured, a button card; onAction() is what actually calls HA
// when the badge reports that button got tapped. The badge never talks
// to HA directly — it only ever POSTs this plugin's own card ids back to
// this host (see action-server.mjs), and this file is the only place
// that holds the long-lived access token and decides what a tap means.

export const id = 'homeassistant';
export const label = 'Home Assistant';
export const description = 'One state card from a sensor/entity, and one optional button card that calls an HA service.';
export const defaultIntervalSeconds = 60;
export const minIntervalSeconds = 15;
export const credentialsSchema = [
  {
    account: 'token',
    label: 'Home Assistant long-lived access token',
    helpUrl: null, // generated on the buyer's own HA instance, under their profile — no central signup page to link to
    required: true,
  },
];
export const settingsSchema = [
  { key: 'baseUrl', label: 'Home Assistant base URL', type: 'text', default: 'http://homeassistant.local:8123' },
  { key: 'stateEntityId', label: 'State card: entity id (blank to skip)', type: 'text', default: '' },
  { key: 'stateLabel', label: 'State card: title', type: 'text', default: '' },
  { key: 'actionEntityId', label: 'Button card: target entity id (blank to skip)', type: 'text', default: '' },
  { key: 'actionLabel', label: 'Button card: title', type: 'text', default: 'HA' },
  { key: 'actionService', label: 'Button card: service to call (domain.service)', type: 'text', default: 'light.toggle' },
];

function slug(entityId) {
  return entityId.replace(/[^a-zA-Z0-9]/g, '_');
}

function actionCardId(entityId) {
  return `ha-action-${slug(entityId)}`;
}

function stateCardId(entityId) {
  return `ha-state-${slug(entityId)}`;
}

function baseUrlOf(settings) {
  const raw = (settings.baseUrl || '').trim();
  if (!raw) throw new Error('No Home Assistant base URL configured.');
  return raw.replace(/\/+$/, '');
}

async function haFetch(baseUrl, token, path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) throw new Error('Home Assistant rejected the access token.');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Home Assistant returned HTTP ${res.status} for ${path}: ${text.slice(0, 200)}`);
  }
  return res;
}

export async function poll(ctx) {
  const token = await ctx.getSecret('token');
  if (!token) throw new Error('No Home Assistant access token stored.');
  const baseUrl = baseUrlOf(ctx.settings);
  const now = Date.now();
  const cards = [];

  if (ctx.settings.stateEntityId) {
    const res = await haFetch(baseUrl, token, `/api/states/${encodeURIComponent(ctx.settings.stateEntityId)}`);
    const entity = await res.json();
    cards.push({
      id: stateCardId(ctx.settings.stateEntityId),
      title: ctx.settings.stateLabel || entity.attributes?.friendly_name || ctx.settings.stateEntityId,
      value: entity.state,
      unit: entity.attributes?.unit_of_measurement || '',
      subtitle: entity.attributes?.friendly_name || ctx.settings.stateEntityId,
      state: 'neutral',
      icon: 'home',
      color: '#2F9BE0',
      editLabel: 'Entity ID',
      editValue: ctx.settings.stateEntityId,
      order: 5,
      updatedAt: now,
      ttlSeconds: 300,
    });
  }

  if (ctx.settings.actionEntityId) {
    // Nexus ba0be49a: the tile used to show the literal string "TAP" no
    // matter what the entity was actually doing — a buyer had no way to
    // tell on from off without leaving the house to look. Reading the
    // entity's own state here (same call the state card above already
    // makes for a different entity) turns this into a real status tile:
    // "ON"/"OFF" as the value, and a bright vs. dim tile color as the
    // at-a-glance signal, on top of the text. Entities whose state isn't
    // on/off (a cover's "open"/"closed", say) still get their raw state
    // uppercased rather than a wrong-looking ON/OFF guess.
    const res = await haFetch(baseUrl, token, `/api/states/${encodeURIComponent(ctx.settings.actionEntityId)}`);
    const entity = await res.json();
    const isOn = entity.state === 'on';
    const isOff = entity.state === 'off';
    cards.push({
      id: actionCardId(ctx.settings.actionEntityId),
      type: 'button',
      title: ctx.settings.actionLabel || entity.attributes?.friendly_name || 'HA',
      value: (isOn || isOff) ? entity.state.toUpperCase() : entity.state,
      subtitle: ctx.settings.actionService || 'light.toggle',
      state: isOn ? 'ok' : 'neutral',
      icon: 'lightbulb',
      color: isOn ? '#F0A020' : '#3A3A3A', // bright amber on, dim grey off/unknown
      editLabel: 'Entity ID',
      editValue: ctx.settings.actionEntityId,
      order: 6,
      updatedAt: now,
      ttlSeconds: 0, // a button doesn't go stale the way a reading does
    });
  }

  if (cards.length === 0) {
    throw new Error('Home Assistant plugin has neither stateEntityId nor actionEntityId configured — nothing to show.');
  }
  return { cards };
}

export async function onAction(ctx, cardId) {
  const token = await ctx.getSecret('token');
  if (!token) throw new Error('No Home Assistant access token stored.');
  if (!ctx.settings.actionEntityId || cardId !== actionCardId(ctx.settings.actionEntityId)) {
    throw new Error(`Unknown action card id for this plugin: ${cardId}`);
  }
  const service = ctx.settings.actionService || 'light.toggle';
  const [domain, svc] = service.split('.');
  if (!domain || !svc) throw new Error(`actionService must be "domain.service", got "${service}".`);

  const baseUrl = baseUrlOf(ctx.settings);
  await haFetch(baseUrl, token, `/api/services/${domain}/${svc}`, {
    method: 'POST',
    body: JSON.stringify({ entity_id: ctx.settings.actionEntityId }),
  });
}

// Nexus 281ee5a2 slice 2: this feed can push two cards (state + button)
// from two different settings keys, so — unlike sports/weather — editing
// has to figure out which half of the config a given card id belongs to
// before it knows what to change. Single-instance either way (one state
// entity, one action entity): deleting either tile has no partial
// "just unset this half" option in this slice, so it falls back to the
// whole-feed-disable behavior like every other single-instance plugin.
export async function onEditValue(ctx, cardId, newValue) {
  const next = String(newValue || '').trim();
  if (!next) throw new Error('Entity id cannot be blank.');
  if (ctx.settings.stateEntityId && cardId === stateCardId(ctx.settings.stateEntityId)) {
    return { settings: { ...ctx.settings, stateEntityId: next }, newCardId: stateCardId(next) };
  }
  if (ctx.settings.actionEntityId && cardId === actionCardId(ctx.settings.actionEntityId)) {
    return { settings: { ...ctx.settings, actionEntityId: next }, newCardId: actionCardId(next) };
  }
  throw new Error(`"${cardId}" isn't one of this feed's configured entity cards.`);
}
