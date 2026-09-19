// tests/osrm.test.js — snapping and alternatives against an in-process OSRM look-alike:
// match works / match says NoMatch / match wanders / server errors / server hangs / nothing listening.
process.env.RASTA_DB = ':memory:';
const http = require('node:http');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { snapToFootway, fetchAlternatives } = require('../lib/osrm');
const scoring = require('../scoring');

const start = { lat: 28.6672, lng: 77.2286 }, end = { lat: 28.6630, lng: 77.2300 };
const footway = [[77.2286, 28.6672], [77.2290, 28.6660], [77.2295, 28.6645], [77.2300, 28.6630]]; // gentle curve, ~470 m
const wild = [[77.2286, 28.6672], [77.25, 28.6672], [77.25, 28.6630], [77.2300, 28.6630]];         // 3× too long
const route = (coords, distance) => ({ distance, duration: distance / 1.3, geometry: { type: 'LineString', coordinates: coords } });

let server, endpoint;
before(async () => {
  server = http.createServer((req, res) => {
    const [, mode, service, , profile] = req.url.split('/'); // /<mode>/<service>/v1/<profile>/...
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (mode === 'down') { res.writeHead(500); return res.end('boom'); }
    if (mode === 'hang') return; // never answers
    if (service === 'match') {
      if (mode === 'ok') return json({ code: 'Ok', matchings: [{ geometry: { type: 'LineString', coordinates: footway }, distance: 470 }] });
      if (mode === 'wild') return json({ code: 'Ok', matchings: [{ geometry: { type: 'LineString', coordinates: wild }, distance: 4500 }] });
      return json({ code: 'NoMatch', message: 'Could not match the trace.' });
    }
    if (service === 'route') {
      if (mode === 'noroute') return json({ code: 'NoRoute' });
      if (profile === 'foot') return json({ code: 'Ok', routes: [route(footway, 470)] });
      if (profile === 'driving') return json({ code: 'Ok', routes: [route(footway, 475), route(wild, 4500)] }); // first is within 4% of foot → dropped
      return json({ code: 'InvalidQuery' });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

describe('snapToFootway', () => {
  test('uses the match geometry when it is plausible', async () => {
    const s = await snapToFootway(start, end, { base: `${endpoint}/ok` });
    assert.equal(s.source, 'osrm-match'); assert.equal(s.snapped, true);
    assert.deepEqual(s.geometry.coordinates, footway);
    assert.equal(s.length_m, Math.round(scoring.polylineLength(footway)));
  });
  test('falls back to the foot route when match finds nothing', async () => {
    const s = await snapToFootway(start, end, { base: `${endpoint}/nomatch` });
    assert.equal(s.source, 'osrm-route'); assert.equal(s.snapped, true);
    assert.deepEqual(s.geometry.coordinates, footway);
  });
  test('rejects a match that wanders (3× the straight line) and takes the route instead', async () => {
    const s = await snapToFootway(start, end, { base: `${endpoint}/wild` });
    assert.equal(s.source, 'osrm-route');
  });
  test('straight line when both match and route fail, when the server errors, hangs, or is not there', async () => {
    const expect = async (base, opts) => {
      const s = await snapToFootway(start, end, { base, timeoutMs: 300, ...opts });
      assert.equal(s.source, 'straight'); assert.equal(s.snapped, false);
      assert.deepEqual(s.geometry.coordinates, [[start.lng, start.lat], [end.lng, end.lat]]);
      assert.equal(s.length_m, Math.round(scoring.haversine(start, end)));
    };
    await expect(`${endpoint}/noroute`);
    await expect(`${endpoint}/down`);
    const t0 = Date.now(); await expect(`${endpoint}/hang`); assert.ok(Date.now() - t0 < 1500, 'timeout honoured');
    await expect('http://127.0.0.1:9');
  });
  test('two points on top of each other skip the network entirely', async () => {
    const s = await snapToFootway(start, { ...start }, { base: 'http://127.0.0.1:9' });
    assert.equal(s.source, 'straight'); assert.equal(s.length_m, 0);
  });
});

describe('fetchAlternatives', () => {
  test('merges foot and driving alternatives, dropping near-duplicates', async () => {
    const r = await fetchAlternatives(start, end, { base: `${endpoint}/ok` });
    assert.equal(r.source, 'osrm');
    assert.equal(r.json.routes.length, 2, 'foot 470 + driving 4500; driving 475 is within 4% of 470');
    assert.deepEqual(r.json.routes.map((x) => x.distance), [470, 4500]);
  });
  test('throws when nothing comes back so the caller can use the cached route', async () => {
    await assert.rejects(fetchAlternatives(start, end, { base: `${endpoint}/down`, timeoutMs: 300 }), /no routes/);
    await assert.rejects(fetchAlternatives(start, end, { base: 'http://127.0.0.1:9', timeoutMs: 300 }), /no routes/);
  });
});
