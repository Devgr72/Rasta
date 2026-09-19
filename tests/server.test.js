// tests/server.test.js — HTTP contract against the exported app, in mock vision mode,
// with an in-memory DB, a temp upload dir, and OSRM pointed at a dead port.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.RASTA_DB = ':memory:';
process.env.RASTA_MOCK_VISION = '1';
process.env.OSRM_BASE = 'http://127.0.0.1:9'; // discard port — nothing listens
process.env.RASTA_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rasta-up-'));
process.env.RASTA_VISION_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rasta-vc-'));
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app, seedIfEmpty } = require('../server');

let server, base;
before(async () => {
  seedIfEmpty();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(process.env.RASTA_UPLOAD_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.RASTA_VISION_CACHE_DIR, { recursive: true, force: true });
});

const json = (method, p, body) => fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
// A tiny valid 1×1 JPEG so the buffer passes the image sniffers.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

describe('GET endpoints', () => {
  test('/api/health reports mock mode and the model', async () => {
    const r = await fetch(base + '/api/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.mock, true); assert.equal(j.model, 'claude-fable-5-1');
  });
  test('/api/standards serves the knowledge file', async () => {
    const j = await (await fetch(base + '/api/standards')).json();
    assert.ok(j.hazard_types.length >= 20);
    assert.equal(j.dimensional_standards.min_clear_width_m, 1.8);
  });
  test('/api/stats has the contract fields and the seed loaded', async () => {
    const j = await (await fetch(base + '/api/stats')).json();
    for (const k of ['segments', 'hazards', 'km_covered', 'avg_score', 'total_cost_inr']) assert.ok(k in j, k);
    assert.ok(j.segments >= 10, 'seed segments present');
  });
  test('/api/segments is GeoJSON', async () => {
    const j = await (await fetch(base + '/api/segments')).json();
    assert.equal(j.type, 'FeatureCollection');
    assert.ok(j.features.length >= 10);
    assert.equal(j.features[0].geometry.type, 'LineString');
  });
  test('/api/segments/1 returns the seed segment with hazards; unknown id is 404', async () => {
    const r = await fetch(base + '/api/segments/1');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.id, 1);
    assert.ok(j.hazards.length > 0);
    assert.ok(j.verdicts.walk.reason);
    const r404 = await fetch(base + '/api/segments/999999');
    assert.equal(r404.status, 404);
    assert.equal((await r404.json()).ok, false);
  });
  test('DELETE /api/segments/:id is 404 when no admin token is configured', async () => {
    const r = await fetch(base + '/api/segments/1', { method: 'DELETE', headers: { authorization: 'Bearer anything' } });
    assert.equal(r.status, 404);
    assert.equal((await fetch(base + '/api/segments/1')).status, 200);
  });
  test('static frontend and report page are served', async () => {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/report.html?id=1')).status, 200);
    assert.equal((await fetch(base + '/vendor/leaflet/leaflet.js')).status, 200);
  });
});

describe('POST /api/segments', () => {
  test('400 on bad points', async () => {
    const r = await json('POST', '/api/segments', { name: 'x', start: { lat: 'abc', lng: 77 }, end: { lat: 28, lng: 77 }, photos: ['data:image/jpeg;base64,' + JPEG.toString('base64')] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /start and end/);
    const r2 = await json('POST', '/api/segments', { name: 'x', start: { lat: 95, lng: 77 }, end: { lat: 28, lng: 77 }, photos: ['data:image/jpeg;base64,AA=='] });
    assert.equal(r2.status, 400, 'latitude out of range');
    const r3 = await json('POST', '/api/segments', { name: 'x', photos: ['data:image/jpeg;base64,AA=='] });
    assert.equal(r3.status, 400, 'missing points');
  });
  test('400 on no photos', async () => {
    const r = await json('POST', '/api/segments', { name: 'x', start: { lat: 28.66, lng: 77.22 }, end: { lat: 28.661, lng: 77.221 }, photos: [] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /at least one photo/);
    const fd = new FormData();
    fd.append('name', 'x'); fd.append('start', JSON.stringify({ lat: 28.66, lng: 77.22 })); fd.append('end', JSON.stringify({ lat: 28.661, lng: 77.221 }));
    const r2 = await fetch(base + '/api/segments', { method: 'POST', body: fd });
    assert.equal(r2.status, 400);
  });
  test('201 on a valid multipart post in mock mode, and the segment is retrievable', async () => {
    const fd = new FormData();
    fd.append('name', 'Test stretch by the metro');
    fd.append('start', JSON.stringify({ lat: 28.6672, lng: 77.2286 }));
    fd.append('end', JSON.stringify({ lat: 28.6640, lng: 77.2295 }));
    fd.append('photos', new Blob([JPEG], { type: 'image/jpeg' }), 'a.jpg');
    fd.append('photos', new Blob([Buffer.concat([JPEG, Buffer.from([1])])], { type: 'image/jpeg' }), 'b.jpg');
    const r = await fetch(base + '/api/segments', { method: 'POST', body: fd });
    const text = await r.text();
    assert.equal(r.status, 201, text);
    const seg = JSON.parse(text);
    assert.equal(seg.name, 'Test stretch by the metro');
    assert.ok(Number.isInteger(seg.id));
    assert.ok(seg.score >= 5 && seg.score <= 100);
    assert.equal(seg.photos.length, 2);
    assert.equal(seg.photos[0].status, 'mock');
    assert.match(seg.photos[0].url, /^\/uploads\/[0-9a-f]{16}\.jpg$/);
    assert.ok(fs.existsSync(path.join(process.env.RASTA_UPLOAD_DIR, path.basename(seg.photos[0].url))), 'photo written to the upload dir');
    assert.ok(Array.isArray(seg.hazards));
    assert.ok(seg.verdicts.walk && seg.verdicts.wheelchair && seg.verdicts.senior);
    assert.ok(seg.cost_by_authority);
    assert.equal(seg.photo_results.length, 2);
    const again = await (await fetch(base + `/api/segments/${seg.id}`)).json();
    assert.equal(again.hazards.length, seg.hazards.length);
    const up = await fetch(base + seg.photos[0].url);
    assert.equal(up.status, 200, 'uploaded photo is served');
  });
  test('JSON body with data URL photos also works', async () => {
    const r = await json('POST', '/api/segments', { name: 'JSON post', start: { lat: 28.66, lng: 77.22 }, end: { lat: 28.661, lng: 77.221 }, photos: ['data:image/jpeg;base64,' + JPEG.toString('base64')] });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).photos.length, 1);
  });
  test('?stream=1 returns NDJSON: start, one photo line per photo, then segment', async () => {
    const fd = new FormData();
    fd.append('name', 'Streamed'); fd.append('start', JSON.stringify({ lat: 28.66, lng: 77.22 })); fd.append('end', JSON.stringify({ lat: 28.661, lng: 77.221 }));
    fd.append('photos', new Blob([JPEG], { type: 'image/jpeg' }), 'a.jpg');
    fd.append('photos', new Blob([Buffer.concat([JPEG, Buffer.from([2])])], { type: 'image/jpeg' }), 'b.jpg');
    const r = await fetch(base + '/api/segments?stream=1', { method: 'POST', body: fd });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /x-ndjson/);
    const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start'); assert.equal(lines[0].photos, 2);
    assert.equal(lines.filter((l) => l.type === 'photo').length, 2);
    assert.equal(lines.at(-1).type, 'segment');
    assert.equal(lines.at(-1).segment.name, 'Streamed');
    const idx = lines.filter((l) => l.type === 'photo').map((l) => l.photo.index).sort();
    assert.deepEqual(idx, [0, 1]);
  });
  test('non-image multipart files are ignored, so a text-only upload is 400', async () => {
    const fd = new FormData();
    fd.append('name', 'x'); fd.append('start', JSON.stringify({ lat: 28.66, lng: 77.22 })); fd.append('end', JSON.stringify({ lat: 28.661, lng: 77.221 }));
    fd.append('photos', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    const r = await fetch(base + '/api/segments', { method: 'POST', body: fd });
    assert.equal(r.status, 400);
  });
});

describe('POST /api/route', () => {
  test('400 on bad points', async () => {
    const r = await json('POST', '/api/route', { from: { lat: 28.66 }, to: { lat: 28.66, lng: 77.23 } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /from and to/);
  });
  test('falls back to the cached demo route when OSRM is unreachable', async () => {
    const r = await json('POST', '/api/route', { from: { lat: 28.6672, lng: 77.2286 }, to: { lat: 28.6598, lng: 77.2288 }, persona: 'wheelchair' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.source, 'cached');
    assert.match(j.warning, /cached demo route/);
    assert.equal(j.persona, 'wheelchair');
    assert.ok(j.routes.length >= 1);
    const rt = j.routes[0];
    for (const k of ['index', 'geometry', 'distance_m', 'duration_min', 'score', 'coverage', 'segments', 'persona_blockers', 'worst_hazard']) assert.ok(k in rt, k);
    assert.equal(rt.geometry.type, 'LineString');
    assert.ok(Number.isInteger(j.recommended_index) || j.recommended_index === null);
    // the demo route runs past Kashmere Gate seed segments, so it should find data
    assert.ok(rt.coverage > 0, `coverage ${rt.coverage}`);
    assert.ok(rt.score != null);
    assert.ok(rt.worst_hazard && rt.worst_hazard.type_id);
    assert.ok(rt.persona_blockers.length > 0, 'wheelchair is blocked on the Kashmere Gate stretch');
  });
  test('unknown persona falls back to walk', async () => {
    const j = await (await json('POST', '/api/route', { from: { lat: 28.6672, lng: 77.2286 }, to: { lat: 28.6598, lng: 77.2288 }, persona: 'dragon' })).json();
    assert.equal(j.persona, 'walk');
  });
});
