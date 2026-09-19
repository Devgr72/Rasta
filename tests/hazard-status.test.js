// tests/hazard-status.test.js — temporary observations age out; structural barriers stay until reported cleared.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { hazardStatus, PERSISTENCE, STALE_MS } = require('../scoring');

const NOW = Date.parse('2026-09-19T12:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

describe('hazardStatus', () => {
  test('knowledge file marks vehicles, vendors, debris, water, waste and vegetation as temporary', () => {
    for (const id of ['parked_vehicle', 'vendor_encroachment', 'construction_debris', 'standing_water', 'garbage_dump', 'overgrown_vegetation']) assert.equal(PERSISTENCE[id], 'temporary', id);
    for (const id of ['no_kerb_ramp', 'open_drain', 'broken_paver', 'high_kerb']) assert.equal(PERSISTENCE[id], 'structural', id);
  });
  test('a fresh temporary sighting reads "observed N minutes ago"', () => {
    const s = hazardStatus({ type_id: 'parked_vehicle', status: 'present', observed_at: iso(25) }, NOW);
    assert.equal(s.key, 'observed'); assert.equal(s.age_min, 25); assert.equal(s.counts, true);
  });
  test('a temporary sighting older than the stale window needs rechecking, and still counts (never auto-cleared)', () => {
    const s = hazardStatus({ type_id: 'parked_vehicle', status: 'present', observed_at: new Date(NOW - STALE_MS - 60000).toISOString() }, NOW);
    assert.equal(s.key, 'recheck'); assert.equal(s.counts, true);
  });
  test('a temporary sighting with no timestamp needs rechecking', () => {
    assert.equal(hazardStatus({ type_id: 'garbage_dump', status: 'present', observed_at: null }, NOW).key, 'recheck');
  });
  test('a temporary sighting re-confirmed by a recheck is "still present"', () => {
    const s = hazardStatus({ type_id: 'garbage_dump', status: 'present', observed_at: iso(10), status_at: iso(10) }, NOW);
    assert.equal(s.key, 'present');
  });
  test('a structural barrier is "still present" however old', () => {
    const s = hazardStatus({ type_id: 'no_kerb_ramp', status: 'present', observed_at: iso(60 * 24 * 400) }, NOW);
    assert.equal(s.key, 'present'); assert.equal(s.persistence, 'structural');
  });
  test('reported cleared stops counting and reports how long ago', () => {
    const s = hazardStatus({ type_id: 'no_kerb_ramp', status: 'cleared', observed_at: iso(5000), status_at: iso(60) }, NOW);
    assert.equal(s.key, 'cleared'); assert.equal(s.counts, false); assert.equal(s.age_min, 60);
  });
});
