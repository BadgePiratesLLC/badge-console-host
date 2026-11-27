// Contract tests for the world clock plugin (Nexus 281ee5a2 slice 4,
// Kevin's own words: "add a time card to be able to add different
// timezones"). No network to mock — poll() is pure Intl/Date math, so
// these tests fix a known instant and assert the formatted output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poll, addCardValue, removeCardValue, editCardValue, description } from '../src/plugins/worldclock.mjs';

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

// Nexus 05eaf268: before this, tap-to-edit-in-place on a world clock tile
// was only reachable via delete-then-+Add — there was no editCardValue()
// at all to swap a slot's city in place.
test('editCardValue swaps the matching slot to a newly resolved city', () => {
  const next = editCardValue({ cities: 'tokyo,london' }, 'worldclock-tokyo', 'paris');
  assert.equal(next.cities, 'paris,london');
});

test('editCardValue resolves an alias/display label the same way addCardValue does', () => {
  const next = editCardValue({ cities: 'tokyo' }, 'worldclock-tokyo', 'nyc');
  assert.equal(next.cities, 'new-york');
});

test('editCardValue returns null for a card id that is not one of this plugin\'s slots', () => {
  assert.equal(editCardValue({ cities: 'tokyo' }, 'worldclock-paris', 'london'), null);
});

test('editCardValue rejects an unrecognized city', () => {
  assert.throws(() => editCardValue({ cities: 'tokyo' }, 'worldclock-tokyo', 'nowhereville'), /don't recognize/i);
});

test('editCardValue rejects swapping to a city already tracked in another slot', () => {
  assert.throws(() => editCardValue({ cities: 'tokyo,london' }, 'worldclock-tokyo', 'london'), /already added/i);
});

test('editCardValue allows re-submitting the same city for its own slot (no-op)', () => {
  const next = editCardValue({ cities: 'tokyo,london' }, 'worldclock-tokyo', 'tokyo');
  assert.equal(next.cities, 'tokyo,london');
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
  // Nexus 05eaf268: the badge only shows a tap-to-edit text field when
  // both of these are set — editCardValue() existing isn't enough on its
  // own for the city to actually be rebindable from the badge.
  assert.equal(result.cards[0].editLabel, 'City');
  assert.equal(result.cards[0].editValue, 'Tokyo');
});

test('poll() skips an unknown stored city key rather than crashing, if another city is still valid', async () => {
  const result = await poll({ settings: { cities: 'tokyo,some-removed-city' } });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].id, 'worldclock-tokyo');
});
