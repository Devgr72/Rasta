// tests/scoring.test.js — the field-checked scoring rules must not drift.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const scoring = require('../scoring');

const { enrichHazard, scoreFromHazards, personaVerdicts, gradeSegment, scoreRoute, haversine, TYPES } = scoring;
const hz = (type_id, severity, extra = {}) => enrichHazard({ type_id, severity, bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, note: 'test', ...extra });

describe('scoreFromHazards', () => {
  test('starts at 100 with no hazards and no width', () => {
    assert.equal(scoreFromHazards([], null), 100);
  });
  test('subtracts severity × 6 per hazard', () => {
    assert.equal(scoreFromHazards([hz('broken_paver', 3)], null), 82);
    assert.equal(scoreFromHazards([hz('broken_paver', 3), hz('open_drain', 5)], null), 100 - 18 - 30);
  });
  test('caps total deduction at 85', () => {
    const many = Array.from({ length: 10 }, () => hz('open_drain', 5)); // 300 raw
    assert.equal(scoreFromHazards(many, null), 15);
  });
  test('width penalty: 15 under 1.2 m, 25 under 0.9 m, none at or above 1.2 m', () => {
    assert.equal(scoreFromHazards([], 1.2), 100);
    assert.equal(scoreFromHazards([], 1.19), 85);
    assert.equal(scoreFromHazards([], 0.9), 85);
    assert.equal(scoreFromHazards([], 0.89), 75);
  });
  test('floors at 5 even when deduction cap plus width penalty exceed 95', () => {
    const many = Array.from({ length: 10 }, () => hz('open_drain', 5));
    assert.equal(scoreFromHazards(many, 0.5), 5);
  });
  test('rounds to an integer', () => {
    assert.ok(Number.isInteger(scoreFromHazards([hz('broken_paver', 2)], 1.0)));
  });
});

describe('enrichHazard', () => {
  test('attaches label, authority, cost and per-persona risk from the knowledge file', () => {
    const h = hz('broken_paver', 4);
    assert.equal(h.label_en, TYPES.broken_paver.label_en);
    assert.equal(h.authority, 'MCD');
    assert.deepEqual(h.risk, { walk: 3, senior: 5, wheelchair: 4 });
    assert.ok(h.cost_inr > 0);
  });
  test('returns null for an unknown type_id', () => {
    assert.equal(enrichHazard({ type_id: 'made_up', severity: 3 }), null);
  });
  test('enforcement-only hazards cost zero', () => {
    assert.equal(hz('parked_vehicle', 3).cost_inr, 0);
  });
});

describe('personaVerdicts', () => {
  test('all pass on a clear footpath, with named reasons', () => {
    const v = personaVerdicts([], 2.0);
    assert.equal(v.walk.ok, true); assert.equal(v.senior.ok, true); assert.equal(v.wheelchair.ok, true);
    for (const k of ['walk', 'senior', 'wheelchair']) assert.ok(v[k].reason.length > 0);
  });
  test('walk fails only when base_severity >= 4', () => {
    // broken_paver base 3 → walk passes; open_drain base 5 → walk fails
    assert.equal(personaVerdicts([hz('broken_paver', 5)], 2).walk.ok, true);
    const v = personaVerdicts([hz('open_drain', 2)], 2);
    assert.equal(v.walk.ok, false);
    assert.match(v.walk.reason, /open drain/i);
    assert.equal(v.walk.hazard_id, 'open_drain');
  });
  test('senior fails on senior_risk >= 4 even when walk passes', () => {
    const v = personaVerdicts([hz('broken_paver', 2)], 2); // senior_risk 5, base 3
    assert.equal(v.walk.ok, true);
    assert.equal(v.senior.ok, false);
    assert.match(v.senior.reason, /paver/i);
  });
  test('wheelchair fails on wheelchair_risk >= 4', () => {
    const v = personaVerdicts([hz('obstructing_pole', 2)], 2); // wheelchair_risk 4
    assert.equal(v.wheelchair.ok, false);
    assert.match(v.wheelchair.reason, /pole/i);
  });
  test('wheelchair fails on no_kerb_ramp regardless of severity', () => {
    const v = personaVerdicts([hz('no_kerb_ramp', 1)], 2);
    assert.equal(v.wheelchair.ok, false);
    assert.equal(v.wheelchair.hazard_id, 'no_kerb_ramp');
    assert.match(v.wheelchair.reason, /kerb ramp/i);
  });
  test('wheelchair fails on clear width under 1.2 m with no hazards', () => {
    const v = personaVerdicts([], 1.1);
    assert.equal(v.wheelchair.ok, false);
    assert.equal(v.wheelchair.hazard_id, 'narrow_path');
    assert.match(v.wheelchair.reason, /1\.1 m/);
    assert.equal(personaVerdicts([], 1.2).wheelchair.ok, true);
  });
  test('width reason is only used when no hazard already blocks', () => {
    const v = personaVerdicts([hz('open_drain', 5)], 0.8);
    assert.equal(v.wheelchair.hazard_id, 'open_drain');
  });
  test('null width never blocks', () => {
    assert.equal(personaVerdicts([], null).wheelchair.ok, true);
  });
  test('the worst hazard by persona risk is the one named', () => {
    const v = personaVerdicts([hz('missing_tactile', 5), hz('open_manhole', 3)], 2);
    assert.equal(v.senior.hazard_id, 'open_manhole');
  });
});

describe('gradeSegment', () => {
  const seg = { name: 'Test', start: { lat: 28.6672, lng: 77.2286 }, end: { lat: 28.6630, lng: 77.2300 } };
  test('aggregates hazards across photos and takes the minimum width', () => {
    const g = gradeSegment(seg, [
      { surface_type: 'paver', estimated_clear_width_m: 1.5, hazards: [{ type_id: 'broken_paver', severity: 3 }] },
      { surface_type: 'paver', estimated_clear_width_m: 1.0, hazards: [{ type_id: 'standing_water', severity: 2 }, { type_id: 'unknown_thing', severity: 5 }] },
    ]);
    assert.equal(g.hazards.length, 2, 'unknown type ids are dropped');
    assert.equal(g.clear_width_m, 1.0);
    assert.equal(g.score, 100 - 18 - 12 - 15);
    assert.equal(g.surface_type, 'paver');
    assert.equal(g.length_m, Math.round(haversine(seg.start, seg.end)));
    assert.equal(g.total_cost_inr, g.hazards.reduce((s, h) => s + h.cost_inr, 0));
    assert.equal(Object.values(g.cost_by_authority).reduce((a, b) => a + b, 0), g.total_cost_inr);
    assert.equal(g.photos.length, 2);
  });
  test('null widths are ignored; all-null gives null', () => {
    const g = gradeSegment(seg, [{ hazards: [], estimated_clear_width_m: null }, { hazards: [] }]);
    assert.equal(g.clear_width_m, null);
    assert.equal(g.score, 100);
  });
  test('surface is the most common non-none value', () => {
    const g = gradeSegment(seg, [{ hazards: [], surface_type: 'none' }, { hazards: [], surface_type: 'concrete' }, { hazards: [], surface_type: 'concrete' }, { hazards: [], surface_type: 'paver' }]);
    assert.equal(g.surface_type, 'concrete');
  });
  test('verdicts carry reasons', () => {
    const g = gradeSegment(seg, [{ hazards: [{ type_id: 'no_kerb_ramp', severity: 3 }], estimated_clear_width_m: 2 }]);
    assert.equal(g.verdicts.wheelchair.ok, false);
    assert.ok(g.verdicts.wheelchair.reason.length > 10);
  });
});

describe('scoreRoute', () => {
  // A straight north-south polyline ~1 km long at Delhi latitude. 0.009° lat ≈ 1000 m.
  const lng = 77.2300;
  const line = Array.from({ length: 11 }, (_, i) => [lng, 28.6600 + i * 0.0009]);
  // segment A sits on the first 200 m, segment B on the last 200 m, C is 2 km away
  const mk = (id, lat0, lat1, score) => ({ id, name: `S${id}`, start: { lat: lat0, lng }, end: { lat: lat1, lng }, score, length_m: Math.round(haversine({ lat: lat0, lng }, { lat: lat1, lng })), verdicts: {} });
  const A = mk(1, 28.6600, 28.6618, 20);
  const B = mk(2, 28.6672, 28.6690, 80);
  const C = mk(3, 28.6800, 28.6818, 100);

  test('samples every 25 m', () => {
    const r = scoreRoute(line, []);
    assert.ok(r.samples >= 39 && r.samples <= 42, `got ${r.samples}`);
    assert.equal(r.score, null);
    assert.equal(r.coverage, 0);
    assert.deepEqual(r.segments, []);
  });
  test('reports coverage as the share of samples within reach of a segment', () => {
    const r = scoreRoute(line, [A, B, C]);
    assert.ok(r.coverage > 30 && r.coverage < 60, `coverage ${r.coverage}`);
    assert.deepEqual(r.segments.map((s) => s.id).sort(), [1, 2], 'far segment is not hit');
  });
  test('weights scores by segment length', () => {
    const r = scoreRoute(line, [A, B]);
    assert.equal(r.score, 50, 'equal lengths → plain average');
    const longB = { ...B, length_m: B.length_m * 3 };
    const r2 = scoreRoute(line, [A, longB]);
    assert.ok(r2.score > 60, `longer high-scoring segment pulls the average up: ${r2.score}`);
  });
  test('a far-away segment gives no data rather than a guess', () => {
    const r = scoreRoute(line, [C]);
    assert.equal(r.score, null);
    assert.equal(r.coverage, 0);
  });
  test('respects custom sample spacing and radius', () => {
    const r = scoreRoute(line, [A], { sampleEveryM: 100, radiusM: 5000 });
    assert.ok(r.samples >= 10 && r.samples <= 12);
    assert.equal(r.coverage, 100);
    assert.equal(r.score, 20);
  });
  test('degenerate one-point polyline still returns a sample', () => {
    const r = scoreRoute([[lng, 28.66]], [A]);
    assert.equal(r.samples, 1);
  });

  // Point-to-polyline matching (Phase 5): the stored footway geometry is what counts, not the midpoint.
  test('a segment whose snapped geometry hugs the route is matched even when its midpoint is far away', () => {
    // A U-shaped footway: start/end both on the route, geometry bulges 300 m east in the middle.
    const U = {
      id: 9, name: 'U', score: 60, verdicts: {},
      start: { lat: 28.6620, lng: lng }, end: { lat: 28.6660, lng: lng },
      geometry: { type: 'LineString', coordinates: [[lng, 28.6620], [lng + 0.003, 28.6620], [lng + 0.003, 28.6660], [lng, 28.6660]] },
    };
    U.length_m = Math.round(scoring.polylineLength(U.geometry.coordinates));
    const r = scoreRoute(line, [U]);
    // only the two short legs touching the route are within 40 m → a handful of samples
    assert.ok(r.coverage > 0 && r.coverage < 20, `coverage ${r.coverage}`);
    assert.deepEqual(r.segments.map((s) => s.id), [9]);
    // by contrast, the old midpoint rule would have matched the whole ~450 m reach
  });
  test('a parallel footway 60 m away is not matched at 40 m, but is at 80 m', () => {
    const dLng = 60 / (111320 * Math.cos((28.665 * Math.PI) / 180));
    const P = { id: 10, name: 'P', score: 90, verdicts: {}, start: { lat: 28.6600, lng: lng + dLng }, end: { lat: 28.6690, lng: lng + dLng }, length_m: 1000,
      geometry: { type: 'LineString', coordinates: [[lng + dLng, 28.6600], [lng + dLng, 28.6690]] } };
    assert.equal(scoreRoute(line, [P]).coverage, 0);
    assert.equal(scoreRoute(line, [P], { radiusM: 80 }).coverage, 100);
  });
  test('segments without geometry fall back to the straight start→end line', () => {
    const r = scoreRoute(line, [{ ...A, geometry: null }]);
    assert.ok(r.coverage > 15 && r.coverage < 30);
  });
});

describe('personaTimes / bestRouteFor', () => {
  const { personaTimes, bestRouteFor, SPEED_MPS } = scoring;
  test('free speeds differ per persona and round to whole minutes', () => {
    const t = personaTimes(1000, []);
    assert.equal(t.walk, Math.round(1000 / SPEED_MPS.walk / 60));
    assert.ok(t.wheelchair > t.walk && t.senior > t.wheelchair, JSON.stringify(t));
    assert.deepEqual(personaTimes(10, []), { walk: 1, wheelchair: 1, senior: 1 }, 'never below a minute');
  });
  test('hazards add time only for personas they affect (risk ≥ 3), scaled by severity', () => {
    const base = personaTimes(1000, []);
    const tactile = personaTimes(1000, [hz('missing_tactile', 5)]); // risks 2/2/1 → nobody slowed
    assert.deepEqual(tactile, base);
    const drain = personaTimes(1000, [hz('open_drain', 5)]); // 5/5/5
    assert.ok(drain.walk > base.walk && drain.wheelchair > base.wheelchair && drain.senior > base.senior);
    assert.ok(drain.wheelchair - base.wheelchair >= drain.walk - base.walk, 'wheelchair pays the biggest detour');
    const raw = personaTimes(1000, [{ type_id: 'open_drain', severity: 5 }]); // un-enriched hazard, risk looked up from TYPES
    assert.deepEqual(raw, drain);
  });
  test('bestRouteFor prefers a passable, well-covered, high-scoring route; falls back sensibly', () => {
    const mk = (index, score, coverage, passable, times, distance_m) => ({ index, score, coverage, passable: { walk: true, wheelchair: passable, senior: true }, times: { walk: times, wheelchair: times + 3, senior: times + 2 }, distance_m });
    const routes = [mk(0, 80, 60, false, 12, 1000), mk(1, 55, 70, true, 15, 1200), mk(2, null, 10, true, 9, 800)];
    assert.equal(bestRouteFor(routes, 'walk'), 0, 'highest score, passable on foot');
    assert.equal(bestRouteFor(routes, 'wheelchair'), 1, 'route 0 is blocked for wheelchairs');
    assert.equal(bestRouteFor([mk(0, 80, 60, false, 12, 1000), mk(1, null, 5, true, 9, 700)], 'wheelchair'), 0, 'no passable covered route → best covered route');
    assert.equal(bestRouteFor([mk(0, null, 5, true, 12, 1000), mk(1, null, 8, true, 9, 700)], 'senior'), 1, 'nothing covered → quickest');
    assert.equal(bestRouteFor([], 'walk'), null);
  });
});

describe('geometry helpers', () => {
  const { polylineLength, bboxOf, padBbox, pointToPolylineM, segmentCoords } = scoring;
  test('polylineLength sums haversine legs', () => {
    const l = polylineLength([[77.23, 28.66], [77.23, 28.669], [77.231, 28.669]]);
    assert.ok(l > 1090 && l < 1110, `${l}`);
    assert.equal(polylineLength([[77.23, 28.66]]), 0);
  });
  test('bboxOf and padBbox', () => {
    const b = bboxOf([[77.23, 28.66], [77.20, 28.67], [77.25, 28.65]]);
    assert.deepEqual(b, { min_lat: 28.65, min_lng: 77.20, max_lat: 28.67, max_lng: 77.25 });
    const p = padBbox(b, 1000);
    assert.ok(Math.abs((b.min_lat - p.min_lat) * 110540 - 1000) < 1);
    assert.ok(p.max_lng > b.max_lng && p.min_lng < b.min_lng);
  });
  test('pointToPolylineM: on the line, off the end, and beside the middle', () => {
    const coords = [[77.23, 28.66], [77.23, 28.67]]; // ~1.1 km north-south
    assert.ok(pointToPolylineM({ lat: 28.665, lng: 77.23 }, coords) < 0.01);
    const beside = pointToPolylineM({ lat: 28.665, lng: 77.2310 }, coords); // ~98 m east
    assert.ok(beside > 95 && beside < 101, `${beside}`);
    const past = pointToPolylineM({ lat: 28.671, lng: 77.23 }, coords); // ~110 m past the north end
    assert.ok(past > 108 && past < 113, `${past}`);
    assert.equal(pointToPolylineM({ lat: 0, lng: 0 }, []), Infinity);
    assert.ok(pointToPolylineM({ lat: 28.66, lng: 77.23 }, [[77.23, 28.66]]) < 0.01, 'single vertex');
  });
  test('segmentCoords prefers stored geometry', () => {
    const s = { start: { lat: 1, lng: 2 }, end: { lat: 3, lng: 4 } };
    assert.deepEqual(segmentCoords(s), [[2, 1], [4, 3]]);
    assert.deepEqual(segmentCoords({ ...s, geometry: { type: 'LineString', coordinates: [[9, 9], [8, 8], [7, 7]] } }), [[9, 9], [8, 8], [7, 7]]);
    assert.deepEqual(segmentCoords({ ...s, geometry: { type: 'LineString', coordinates: [[9, 9]] } }), [[2, 1], [4, 3]], 'degenerate geometry ignored');
  });
});
