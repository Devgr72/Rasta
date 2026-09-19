// tests/geocode.test.js — place search against an in-process Nominatim look-alike: mapping, bias box,
// caching, reverse lookup, and failure handling. The env var must be set before the module loads.
const http = require('node:http');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

let server, hits = [];
before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/search') {
      if (u.searchParams.get('q') === 'nowhere') return res.end('[]');
      if (u.searchParams.get('q') === 'boom') { res.statusCode = 503; return res.end('{}'); }
      return res.end(JSON.stringify([
        { lat: '28.6672', lon: '77.2286', display_name: 'Kashmere Gate, Kashmere Gate Metro Station, Old Delhi, Delhi, 110006, India', name: 'Kashmere Gate', type: 'station', importance: 0.6, address: { railway: 'Kashmere Gate', suburb: 'Old Delhi', city: 'Delhi' } },
        { lat: '28.66', lon: '77.23', display_name: 'Lothian Road, Old Delhi, Delhi, India', type: 'road', importance: 0.3, address: { road: 'Lothian Road', suburb: 'Old Delhi' } },
        { lat: 'x', lon: 'y', display_name: 'broken' },
      ]));
    }
    if (u.pathname === '/reverse') {
      if (u.searchParams.get('lat') === '0') return res.end(JSON.stringify({ error: 'Unable to geocode' }));
      return res.end(JSON.stringify({ display_name: 'Chandni Chowk, Old Delhi, Delhi, India', name: 'Chandni Chowk', address: { road: 'Chandni Chowk', suburb: 'Old Delhi' } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.RASTA_GEOCODER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.RASTA_GEOCODER_COUNTRY = 'in';
});
after(() => new Promise((r) => server.close(r)));

describe('geocode', () => {
  test('search maps results to {name, lat, lng}, drops junk, biases to the map and country', async () => {
    const geocode = require('../lib/geocode');
    const r = await geocode.search('kashmere gate', { near: { lat: 28.66, lng: 77.23 } });
    assert.equal(r.length, 2);
    assert.equal(r[0].name, 'Kashmere Gate, Old Delhi');
    assert.equal(r[0].lat, 28.6672); assert.equal(r[0].lng, 77.2286); assert.equal(r[0].type, 'station');
    assert.equal(r[1].name, 'Lothian Road, Old Delhi');
    const url = new URL(hits.at(-1), 'http://x');
    assert.equal(url.searchParams.get('countrycodes'), 'in');
    assert.ok(url.searchParams.get('viewbox'), 'viewbox bias present');
    assert.equal(url.searchParams.get('format'), 'jsonv2');
  });
  test('identical searches are served from the cache', async () => {
    const geocode = require('../lib/geocode');
    const n = hits.length;
    await geocode.search('kashmere gate', { near: { lat: 28.66, lng: 77.23 } });
    assert.equal(hits.length, n, 'no upstream call');
    await geocode.search('kashmere gate');
    assert.equal(hits.length, n + 1, 'different bias → new call');
  });
  test('short or empty queries return [] without calling upstream; no results → []', async () => {
    const geocode = require('../lib/geocode');
    const n = hits.length;
    assert.deepEqual(await geocode.search('a'), []);
    assert.deepEqual(await geocode.search(''), []);
    assert.equal(hits.length, n);
    assert.deepEqual(await geocode.search('nowhere'), []);
  });
  test('upstream errors propagate as an Error the route turns into a 502', async () => {
    const geocode = require('../lib/geocode');
    await assert.rejects(geocode.search('boom'), /geocoder 503/);
  });
  test('reverse returns a short name, and null when the geocoder has nothing', async () => {
    const geocode = require('../lib/geocode');
    const p = await geocode.reverse(28.6565, 77.2300);
    assert.equal(p.name, 'Chandni Chowk, Old Delhi');
    assert.match(p.display_name, /Chandni Chowk/);
    assert.equal(await geocode.reverse(0, 0), null);
  });
});
