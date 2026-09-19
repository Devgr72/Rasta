// tests/protect.test.js — Phase 3 guards: CSP headers, rate limiting, upload caps, admin delete, usage stats.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.RASTA_DB = ':memory:';
process.env.RASTA_MOCK_VISION = '1';
process.env.OSRM_BASE = 'http://127.0.0.1:9';
process.env.RASTA_UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rasta-up-'));
process.env.RASTA_VISION_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rasta-vc-'));
process.env.RASTA_ADMIN_TOKEN = 'test-admin-token-123';
process.env.RASTA_RATE_LIMIT_ROUTE = '3';
process.env.RASTA_RATE_LIMIT_SEGMENTS = '50';
process.env.RASTA_MAX_IMAGE_PX = '1000';
process.env.RASTA_MAX_UPLOAD_MB = '1';
process.env.RASTA_TILE_URL = 'https://{s}.tiles.example.org/{z}/{x}/{y}.png';
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

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const png = (w, h) => { const b = Buffer.alloc(64); b.write('\x89PNG\r\n\x1a\n', 'binary'); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const segBody = (photos) => ({ name: 'guard', start: { lat: 28.66, lng: 77.22 }, end: { lat: 28.661, lng: 77.221 }, photos });
const dataUrl = (b, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;

describe('security headers', () => {
  test('helmet CSP allows self scripts, the configured tile host, Google Fonts and blob images', async () => {
    const r = await fetch(base + '/');
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header present');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /img-src[^;]*https:\/\/\*\.tiles\.example\.org/);
    assert.match(csp, /img-src[^;]*blob:/);
    assert.match(csp, /img-src[^;]*data:/);
    assert.match(csp, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
  test('report page has no inline script (CSP would block it)', async () => {
    const html = await (await fetch(base + '/report.html')).text();
    assert.doesNotMatch(html, /onclick=/);
    assert.doesNotMatch(html, /<script>[^<]/);
    assert.match(html, /<script src="\/report\.js">/);
    assert.equal((await fetch(base + '/report.js')).status, 200);
  });
});

describe('upload caps', () => {
  test('rejects an image whose decoded dimensions exceed RASTA_MAX_IMAGE_PX', async () => {
    const r = await post('/api/segments', segBody([dataUrl(png(4000, 3000))]));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /4000×3000 px/);
  });
  test('rejects bytes that are not a recognisable image', async () => {
    const r = await post('/api/segments', segBody([dataUrl(Buffer.from('this is definitely not a picture of a footpath, sorry'), 'image/jpeg')]));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /not a JPEG, PNG, WebP or GIF/);
  });
  test('rejects a request whose photos total more than RASTA_MAX_UPLOAD_MB', async () => {
    const fd = new FormData();
    fd.append('name', 'big'); fd.append('start', JSON.stringify({ lat: 28.66, lng: 77.22 })); fd.append('end', JSON.stringify({ lat: 28.661, lng: 77.221 }));
    const big = Buffer.concat([png(800, 600), Buffer.alloc(700 * 1024)]);
    fd.append('photos', new Blob([big], { type: 'image/png' }), 'a.png');
    fd.append('photos', new Blob([big], { type: 'image/png' }), 'b.png');
    const r = await fetch(base + '/api/segments', { method: 'POST', body: fd });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /limit is 1 MB/);
  });
  test('an oversized JSON body is 413, not a crash', async () => {
    const r = await post('/api/segments', segBody([dataUrl(Buffer.concat([png(10, 10), Buffer.alloc(1.2 * 1024 * 1024)]))]));
    assert.equal(r.status, 413);
    assert.equal((await r.json()).ok, false);
  });
  test('a sane photo still goes through', async () => {
    const r = await post('/api/segments', segBody([dataUrl(JPEG, 'image/jpeg')]));
    assert.equal(r.status, 201);
  });
});

describe('rate limiting', () => {
  test('POST /api/route is limited per IP with a JSON 429 and RateLimit headers', async () => {
    const body = { from: { lat: 28.6672, lng: 77.2286 }, to: { lat: 28.6598, lng: 77.2288 } };
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/route', body);
      statuses.push(r.status);
      if (r.status === 429) {
        const j = await r.json();
        assert.equal(j.ok, false);
        assert.match(j.error, /Too many route requests/);
        assert.equal(j.retry_after_min, 15);
        assert.ok(r.headers.get('ratelimit'), 'draft-7 RateLimit header present');
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  });
});

describe('admin delete', () => {
  test('401 without a bearer token, 401 with the wrong one', async () => {
    assert.equal((await fetch(base + '/api/segments/1', { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(base + '/api/segments/1', { method: 'DELETE', headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(base + '/api/segments/1')).status, 200, 'segment untouched');
  });
  test('deletes with the right token, cascades, removes orphaned files, then 404s', async () => {
    // create a segment with a real uploaded photo so there is a file to orphan
    const fd = new FormData();
    fd.append('name', 'to delete'); fd.append('start', JSON.stringify({ lat: 28.66, lng: 77.22 })); fd.append('end', JSON.stringify({ lat: 28.661, lng: 77.221 }));
    fd.append('photos', new Blob([Buffer.concat([JPEG, Buffer.from('unique-delete-bytes')])], { type: 'image/jpeg' }), 'd.jpg');
    const seg = await (await fetch(base + '/api/segments', { method: 'POST', body: fd })).json();
    const file = path.join(process.env.RASTA_UPLOAD_DIR, path.basename(seg.photos[0].url));
    assert.ok(fs.existsSync(file));

    const auth = { authorization: `Bearer ${process.env.RASTA_ADMIN_TOKEN}` };
    const r = await fetch(base + `/api/segments/${seg.id}`, { method: 'DELETE', headers: auth });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.id, seg.id); assert.equal(j.files_removed, 1);
    assert.equal(fs.existsSync(file), false, 'orphaned upload removed');
    assert.equal((await fetch(base + `/api/segments/${seg.id}`)).status, 404);
    assert.equal((await fetch(base + `/api/segments/${seg.id}`, { method: 'DELETE', headers: auth })).status, 404);
    assert.equal((await fetch(base + '/api/segments/abc', { method: 'DELETE', headers: auth })).status, 400);
  });
});

describe('usage stats', () => {
  test('/api/stats exposes vision token usage for today and overall, and /api/health the budget state', async () => {
    const s = await (await fetch(base + '/api/stats')).json();
    assert.ok(s.vision, 'vision block present');
    for (const scope of ['today', 'total']) {
      for (const k of ['calls', 'model_calls', 'cache_hits', 'errors', 'input_tokens', 'output_tokens', 'tokens']) assert.equal(typeof s.vision[scope][k], 'number', `${scope}.${k}`);
    }
    assert.ok(s.vision.today.calls >= 2, 'mock calls were recorded');
    assert.ok(s.vision.today.mock_calls >= 2);
    assert.equal(s.vision.today.model_calls, 0, 'mock rows are not counted as model calls');
    assert.equal(s.vision.budget, null, 'no budget configured');
    assert.equal(s.vision.budget_reached, false);
    assert.equal(s.vision.concurrency, 4);
    assert.equal(s.segments, 11, 'seed + the one sane upload (deleted one is gone)');
    const h = await (await fetch(base + '/api/health')).json();
    assert.equal(h.budget_reached, false);
    assert.equal(h.concurrency, 4);
    assert.equal(h.daily_token_budget, null);
  });
});
