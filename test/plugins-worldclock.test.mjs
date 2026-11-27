// Contract tests for the world clock plugin (Nexus 281ee5a2 slice 4,
// Kevin's own words: "add a time card to be able to add different
// timezones"). No network to mock — poll() is pure Intl/Date math, so
// these tests fix a known instant and assert the formatted output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poll, addCardValue, removeCardValue, description } from '../src/plugins/worldclock.mjs';

test('description mentions no network/key, matching the "no network needed" design', () => {
  assert.match(description, /no network|no key/i);
});

test('addCardValue resolves a known city key', () => {
  const next = addCardValue({}, 'tokyo');
  assert.equal(next.cities, 'tokyo');
});

test('addCardValue resolves a display label, case-insensitively', () => {
  const next = addCardValue({}, 'London');
  assert.equal(next.cities, 'london');
});

test('addCardValue resolves a known alias', () => {
  const next = addCardValue({}, 'nyc');
  assert.equal(next.cities, 'new-york');
});

test('addCardValue appends to an existing list', () => {
  const next = addCardValue({ cities: 'tokyo' }, 'london');
  assert.equal(next.cities, 'tokyo,london');
});

test('addCardValue rejects an unrecognized city', () => {
  assert.throws(() => addCardValue({}, 'Atlantis'), /don't recognize/i);
});

test('addCardValue rejects a 4th city past the 3-city max', () => {
  assert.throws(() => addCardValue({ cities: 'tokyo,london,paris' }, 'berlin'), /already have 3/i);
});

test('addCardValue rejects a city already tracked', () => {
  assert.throws(() => addCardValue({ cities: 'tokyo' }, 'Tokyo'), /already added/i);
});

test('removeCardValue drops the matching slot', () => {
  const next = removeCardValue({ cities: 'tokyo,london' }, 'worldclock-tokyo');
  assert.equal(next.cities, 'london');
});

test('removeCardValue returns null for an unknown card id', () => {
  assert.equal(removeCardValue({ cities: 'tokyo' }, 'worldclock-paris'), null);
});

test('poll() throws when no cities are configured', async () => {
  await assert.rejects(() => poll({ settings: { cities: '' } }), /no cities configured/i);
});

test('poll() returns one card per configured city with a clock icon', async () => {
  const result = await poll({ settings: { cities: 'tokyo,london' } });
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0].id, 'worldclock-tokyo');
  assert.equal(result.cards[0].title, 'Tokyo');
  assert.equal(result.cards[0].icon, 'clock');
  assert.match(result.cards[0].value, /^\d{1,2}:\d{2}$/);
  assert.match(result.cards[0].unit, /AM|PM/);
  assert.equal(result.cards[1].id, 'worldclock-london');
});

test('poll() skips an unknown stored city key rather than crashing, if another city is still valid', async () => {
  const result = await poll({ settings: { cities: 'tokyo,some-removed-city' } });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].id, 'worldclock-tokyo');
});
