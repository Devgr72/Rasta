// tests/perf.test.js — route scoring must stay fast with ten thousand segments on the map.
process.env.RASTA_DB = ':memory:';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const scoring = require('../scoring');
const demo = require('../data/demo-route.json');

describe('route scoring at scale', () => {
  test('10,000 segments: bbox pre-filter + polyline scoring of the demo route well under a second', () => {
    // Spread segments over greater Delhi (28.40–28.90 N, 76.85–77.40 E), ~200 m each, random headings.
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const insertMany = db.db.transaction(() => {
      for (let i = 0; i < 10000; i++) {
        const lat = 28.40 + rnd() * 0.5, lng = 76.85 + rnd() * 0.55, a = rnd() * Math.PI * 2;
        const start = { lat, lng }, end = { lat: lat + Math.sin(a) * 0.0018, lng: lng + Math.cos(a) * 0.002 };
        const g = scoring.gradeSegment({ name: `S${i}`, start, end }, [{ hazards: i % 3 ? [{ type_id: 'broken_paver', severity: 1 + (i % 5) }] : [], estimated_clear_width_m: 1 + rnd() * 2 }]);
        db.saveSegment(g, g.photos);
      }
    });
    const tInsert = Date.now(); insertMany();
    assert.equal(db.stats().segments, 10000);
    console.log(`  inserted 10,000 segments in ${Date.now() - tInsert} ms`);

    const coords = demo.routes[0].geometry.coordinates;
    const t0 = Date.now();
    const candidates = db.segmentsInBbox(scoring.padBbox(scoring.bboxOf(coords), 40));
    const tQuery = Date.now() - t0;
    const t1 = Date.now();
    const scored = scoring.scoreRoute(coords, candidates);
    const tScore = Date.now() - t1;
    console.log(`  bbox query ${tQuery} ms → ${candidates.length} candidates; scoreRoute ${tScore} ms; coverage ${scored.coverage}%`);
    assert.ok(candidates.length < 500, `pre-filter should cut 10,000 down hard, got ${candidates.length}`);
    assert.ok(tQuery + tScore < 800, `route scoring took ${tQuery + tScore} ms`);

    // and the pre-filter does not change the answer
    const full = scoring.scoreRoute(coords, db.allSegments());
    assert.equal(scored.score, full.score);
    assert.equal(scored.coverage, full.coverage);
    assert.deepEqual(scored.segments.map((s) => s.id).sort(), full.segments.map((s) => s.id).sort());
  });
});
