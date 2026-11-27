// Contract tests for the Home Assistant plugin (Nexus 7c9c1a15, scope
// addition 2026-11-21: button cards that control HA + info cards that
// show HA state). No real House HA instance in CI, so this mocks
// global.fetch the same way plugins-anthropic-openai.test.mjs and
// plugins-stocks.test.mjs do — proving the state-card read path, the
// button-card shape, the onAction() service-call path, and that a bad
// token or a tap on an id this plugin doesn't own fails loudly rather
// than silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poll, onAction, editCardValue } from '../src/plugins/homeassistant.mjs';

function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const baseSettings = { baseUrl: 'http://ha.local:8123' };

test('poll() throws with no token stored, and never calls HA', async () => {
  let called = false;
  await withMockFetch(
    async () => { called = true; throw new Error('should not be called'); },
    async () => {
      await assert.rejects(
        () => poll({ settings: { ...baseSettings, stateEntityId: 'sensor.x' }, getSecret: async () => null }),
        /No Home Assistant access token/,
      );
    },
  );
  assert.equal(called, false);
});

test('poll() throws if neither stateEntityId nor actionEntityId is configured', async () => {
  await assert.rejects(
    () => poll({ settings: baseSettings, getSecret: async () => 'tok' }),
    /nothing to show/,
  );
});

test('poll() reads a state entity into one card', async () => {
  await withMockFetch(
    async (url) => {
      assert.match(url, /\/api\/states\/sensor\.office_temp$/);
      return jsonResponse(200, { state: '71.5', attributes: { unit_of_measurement: '°F', friendly_name: 'Office Temp' } });
    },
    async () => {
      const result = await poll({
        settings: { ...baseSettings, stateEntityId: 'sensor.office_temp' },
        getSecret: async () => 'tok',
      });
      assert.equal(result.cards.length, 1);
      assert.equal(result.cards[0].id, 'ha-state-sensor_office_temp');
      assert.equal(result.cards[0].value, '71.5');
      assert.equal(result.cards[0].unit, '°F');
      assert.equal(result.cards[0].title, 'Office Temp');
      // Nexus 05eaf268: the badge only shows a tap-to-edit text field when
      // both of these are set — editCardValue() existing isn't enough on
      // its own for the entity id to actually be rebindable from the badge.
      assert.equal(result.cards[0].editLabel, 'Entity id');
      assert.equal(result.cards[0].editValue, 'sensor.office_temp');
    },
  );
});

test('poll() rounds a raw-float sensor state to one decimal (Nexus 64644fa0)', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { state: '68.2970016479492', attributes: { unit_of_measurement: '°F' } }),
    async () => {
      const result = await poll({
        settings: { ...baseSettings, stateEntityId: 'sensor.office_temp' },
        getSecret: async () => 'tok',
      });
      assert.equal(result.cards[0].value, '68.3');
    },
  );
});

test('poll() leaves a non-numeric sensor state untouched', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { state: 'unavailable', attributes: {} }),
    async () => {
      const result = await poll({
        settings: { ...baseSettings, stateEntityId: 'sensor.office_temp' },
        getSecret: async () => 'tok',
      });
      assert.equal(result.cards[0].value, 'unavailable');
    },
  );
});

test('poll() emits a type: "button" card showing ON, bright, when the entity is on', async () => {
  await withMockFetch(
    async (url) => {
      assert.match(url, /\/api\/states\/light\.office_accent$/);
      return jsonResponse(200, { state: 'on', attributes: {} });
    },
    async () => {
      const result = await poll({
        settings: { ...baseSettings, actionEntityId: 'light.office_accent', actionLabel: 'Office Light', actionService: 'light.toggle' },
        getSecret: async () => 'tok',
      });
      assert.equal(result.cards.length, 1);
      assert.equal(result.cards[0].type, 'button');
      assert.equal(result.cards[0].id, 'ha-action-light_office_accent');
      assert.equal(result.cards[0].title, 'Office Light');
      assert.equal(result.cards[0].value, 'ON');
      assert.equal(result.cards[0].state, 'ok');
      assert.equal(result.cards[0].color, '#F0A020');
      assert.equal(result.cards[0].editLabel, 'Entity id');
      assert.equal(result.cards[0].editValue, 'light.office_accent');
    },
  );
});

test('poll() emits a type: "button" card showing OFF, dim, when the entity is off', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { state: 'off', attributes: {} }),
    async () => {
      const result = await poll({
        settings: { ...baseSettings, actionEntityId: 'light.office_accent', actionService: 'light.toggle' },
        getSecret: async () => 'tok',
      });
      assert.equal(result.cards[0].value, 'OFF');
      assert.equal(result.cards[0].state, 'neutral');
      assert.equal(result.cards[0].color, '#3A3A3A');
    },
  );
});

test('poll() uppercases a non on/off state as-is rather than guessing ON/OFF', async () => {
  await withMockFetch(
    async () => jsonResponse(200, { state: 'opening', attributes: {} }),
    async () => {
      const result = await poll({
        settings: { ...baseSettings, actionEntityId: 'cover.garage', actionService: 'cover.toggle' },
        getSecret: async () => 'tok',
      });
      assert.equal(result.cards[0].value, 'opening');
    },
  );
});

test('poll() surfaces a rejected token (401) as a clear error, not a zero', async () => {
  await withMockFetch(
    async () => jsonResponse(401, { message: 'unauthorized' }),
    async () => {
      await assert.rejects(
        () => poll({ settings: { ...baseSettings, stateEntityId: 'sensor.x' }, getSecret: async () => 'bad-token' }),
        /rejected the access token/,
      );
    },
  );
});

test('onAction() calls the configured HA service with the target entity', async () => {
  const calls = [];
  await withMockFetch(
    async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse(200, []);
    },
    async () => {
      await onAction(
        { settings: { ...baseSettings, actionEntityId: 'light.office_accent', actionService: 'light.toggle' }, getSecret: async () => 'tok' },
        'ha-action-light_office_accent',
      );
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/services\/light\/toggle$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { entity_id: 'light.office_accent' });
});

test('onAction() rejects a card id that does not belong to this plugin\'s configured action', async () => {
  await assert.rejects(
    () => onAction(
      { settings: { ...baseSettings, actionEntityId: 'light.office_accent' }, getSecret: async () => 'tok' },
      'ha-action-some-other-entity',
    ),
    /Unknown action card id/,
  );
});

test('onAction() rejects a malformed actionService before ever calling fetch', async () => {
  let called = false;
  await withMockFetch(
    async () => { called = true; return jsonResponse(200, []); },
    async () => {
      await assert.rejects(
        () => onAction(
          { settings: { ...baseSettings, actionEntityId: 'light.x', actionService: 'notadotservice' }, getSecret: async () => 'tok' },
          'ha-action-light_x',
        ),
        /must be "domain\.service"/,
      );
    },
  );
  assert.equal(called, false);
});

// Nexus 05eaf268: this plugin had no editCardValue() at all — an entity
// id could only be rebound from the Feeds page, not the badge's own
// layout editor, since plugin-runtime.mjs's handleEdit() had nothing to
// call for either HA card. Pure function, no network needed.
test('editCardValue rebinds the state card\'s entity id', () => {
  const settings = { ...baseSettings, stateEntityId: 'sensor.office_temp' };
  const next = editCardValue(settings, 'ha-state-sensor_office_temp', 'sensor.bedroom_temp');
  assert.equal(next.stateEntityId, 'sensor.bedroom_temp');
});

test('editCardValue rebinds the action card\'s entity id', () => {
  const settings = { ...baseSettings, actionEntityId: 'light.office_accent' };
  const next = editCardValue(settings, 'ha-action-light_office_accent', 'light.bedroom_lamp');
  assert.equal(next.actionEntityId, 'light.bedroom_lamp');
});

test('editCardValue returns null for a card id neither current slot matches', () => {
  const settings = { ...baseSettings, stateEntityId: 'sensor.office_temp' };
  assert.equal(editCardValue(settings, 'ha-state-sensor_bedroom_temp', 'sensor.x'), null);
});

test('editCardValue returns null for a blank new value', () => {
  const settings = { ...baseSettings, stateEntityId: 'sensor.office_temp' };
  assert.equal(editCardValue(settings, 'ha-state-sensor_office_temp', '  '), null);
});
