// tests/db.test.js — round-trips against an in-memory SQLite database.
process.env.RASTA_DB = ':memory:';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const scoring = require('../scoring');

const seg = { name: 'Round trip', start: { lat: 28.6672, lng: 77.2286 }, end: { lat: 28.6630, lng: 77.2300 } };
const photos = [
  { filename: 'abc.jpg', hash: 'abc', estimated_clear_width_m: 1.0, surface_type: 'paver', observations: 'first', status: 'ok',
    hazards: [{ type_id: 'broken_paver', severity: 4, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, note: 'six tiles' }, { type_id: 'no_kerb_ramp', severity: 3, bbox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, note: 'no ramp' }] },
  { filename: null, hash: 'def', estimated_clear_width_m: null, surface_type: 'none', observations: '', status: 'failed', hazards: [] },
];

describe('db', () => {
  let id;
  before(() => {
    assert.equal(db.isEmpty(), true, 'fresh in-memory db is empty');
    const graded = scoring.gradeSegment(seg, photos);
    id = db.saveSegment(graded, graded.photos);
  });

  test('saveSegment returns an id and the db is no longer empty', () => {
    assert.ok(Number.isInteger(id) && id > 0);
    assert.equal(db.isEmpty(), false);
  });

  test('getSegment returns the API shape with verdicts, photos and hazards', () => {
    const s = db.getSegment(id);
    assert.equal(s.id, id);
    assert.equal(s.name, 'Round trip');
    assert.deepEqual(s.start, seg.start);
    assert.deepEqual(s.end, seg.end);
    assert.equal(s.score, 100 - 24 - 18 - 15);
    assert.equal(s.clear_width_m, 1.0);
    assert.equal(s.surface_type, 'paver');
    assert.equal(s.hazard_count, 2);
    assert.equal(s.photo_count, 2);
    assert.equal(typeof s.created_at, 'string');
    for (const k of ['walk', 'wheelchair', 'senior']) {
      assert.equal(typeof s.verdicts[k].ok, 'boolean');
      assert.ok(s.verdicts[k].reason.length > 0);
    }
    assert.equal(s.verdicts.wheelchair.ok, false);

    assert.equal(s.photos.length, 2);
    assert.equal(s.photos[0].url, '/uploads/abc.jpg');
    assert.equal(s.photos[1].url, null, 'photo without a file has no url');
    assert.equal(s.photos[1].status, 'failed');

    assert.equal(s.hazards.length, 2);
    assert.equal(s.hazards[0].severity, 4, 'hazards ordered by severity desc');
    assert.equal(s.hazards[0].photo_id, s.photos[0].id, 'hazard links to its photo');
    assert.deepEqual(s.hazards[0].bbox, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
    assert.equal(s.hazards[0].authority, 'MCD');
    assert.ok(s.hazards[0].cost_inr > 0);
    assert.equal(s.total_cost_inr, s.hazards.reduce((a, h) => a + h.cost_inr, 0));
  });

  test('getSegment returns null for a missing id', () => {
    assert.equal(db.getSegment(999999), null);
  });

  test('allSegments returns summaries with counts', () => {
    const all = db.allSegments();
    assert.equal(all.length, 1);
    assert.equal(all[0].hazard_count, 2);
    assert.equal(all[0].photo_count, 2);
    assert.equal(all[0].photos, undefined, 'summary has no photo list');
  });

  test('toGeoJSON is a FeatureCollection of LineStrings with segment properties', () => {
    const gj = db.toGeoJSON();
    assert.equal(gj.type, 'FeatureCollection');
    assert.equal(gj.features.length, 1);
    const f = gj.features[0];
    assert.equal(f.type, 'Feature');
    assert.equal(f.id, id);
    assert.equal(f.geometry.type, 'LineString');
    assert.deepEqual(f.geometry.coordinates[0], [seg.start.lng, seg.start.lat], '[lng, lat] order');
    assert.deepEqual(f.geometry.coordinates.at(-1), [seg.end.lng, seg.end.lat]);
    assert.equal(f.properties.id, id);
    assert.equal(f.properties.score, 43);
    assert.equal(f.properties.verdicts.wheelchair.ok, false);
  });

  test('stats aggregates counts, km and averages', () => {
    const s = db.stats();
    assert.equal(s.segments, 1);
    assert.equal(s.hazards, 2);
    assert.ok(s.km_covered > 0.4 && s.km_covered < 0.6);
    assert.equal(s.avg_score, 43);
    assert.ok(s.total_cost_inr > 0);
    assert.equal(s.wheelchair_ok_count, 0);
    assert.equal(typeof s.senior_ok_count, 'number');
  });

  test('a second segment updates stats and the collection', () => {
    const graded = scoring.gradeSegment({ ...seg, name: 'Clear one' }, [{ hazards: [], estimated_clear_width_m: 2.5, surface_type: 'stone' }]);
    const id2 = db.saveSegment(graded, graded.photos);
    assert.equal(id2, id + 1);
    const s = db.stats();
    assert.equal(s.segments, 2);
    assert.equal(s.wheelchair_ok_count, 1);
    assert.equal(s.avg_score, Math.round((43 + 100) / 2));
    assert.equal(db.toGeoJSON().features.length, 2);
  });

  test('deleting a segment cascades to photos and hazards', () => {
    db.db.prepare('DELETE FROM segments WHERE id = ?').run(id);
    assert.equal(db.getSegment(id), null);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM hazards WHERE segment_id = ?').get(id).n, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE segment_id = ?').get(id).n, 0);
  });
});
