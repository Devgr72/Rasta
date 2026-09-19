// tests/vision.test.js — parsing, validation and the mock/cache path. No API call is ever made.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.RASTA_DB = ':memory:'; // vision.js records usage through db.js — keep it off the real file
process.env.RASTA_MOCK_VISION = '1';
process.env.RASTA_VISION_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rasta-vc-'));
delete process.env.ANTHROPIC_API_KEY;

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const vision = require('../vision');
const { stripFences, validate, analysePhoto, sha256, MOCK } = vision;

after(() => { fs.rmSync(process.env.RASTA_VISION_CACHE_DIR, { recursive: true, force: true }); });

const GOOD = { surface_type: 'paver', hazards: [{ type_id: 'broken_paver', severity: 4, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, note: 'n' }], estimated_clear_width_m: 1.4, observations: 'o' };

describe('stripFences', () => {
  test('clean JSON passes through', () => {
    assert.deepEqual(JSON.parse(stripFences(JSON.stringify(GOOD))), GOOD);
  });
  test('```json fences are removed', () => {
    assert.deepEqual(JSON.parse(stripFences('```json\n' + JSON.stringify(GOOD) + '\n```')), GOOD);
    assert.deepEqual(JSON.parse(stripFences('```\n' + JSON.stringify(GOOD) + '```')), GOOD);
  });
  test('prose before and after the object is trimmed', () => {
    const t = 'Here is the audit you asked for:\n' + JSON.stringify(GOOD) + '\nLet me know if you need more.';
    assert.deepEqual(JSON.parse(stripFences(t)), GOOD);
  });
  test('nested braces in strings survive', () => {
    const obj = { ...GOOD, observations: 'has { braces } inside' };
    assert.deepEqual(JSON.parse(stripFences('```json ' + JSON.stringify(obj) + ' ```')), obj);
  });
});

describe('validate', () => {
  test('throws on non-object or missing hazards array (so the repair retry triggers)', () => {
    assert.throws(() => validate(null), /not an object/);
    assert.throws(() => validate('str'), /not an object/);
    assert.throws(() => validate({ hazards: 'nope' }), /not an array/);
  });
  test('drops hazards with unknown type_id', () => {
    const v = validate({ hazards: [{ type_id: 'pothole_of_doom', severity: 5 }, GOOD.hazards[0]] });
    assert.equal(v.hazards.length, 1);
    assert.equal(v.hazards[0].type_id, 'broken_paver');
  });
  test('clamps severity to 1..5 and rounds; missing, zero or non-numeric default to 3', () => {
    const sev = (s) => validate({ hazards: [{ type_id: 'open_drain', severity: s }] }).hazards[0].severity;
    assert.equal(sev(9), 5); assert.equal(sev(-3), 1); assert.equal(sev(3.6), 4); assert.equal(sev('4'), 4);
    assert.equal(sev(0), 3); assert.equal(sev(undefined), 3); assert.equal(sev('abc'), 3);
  });
  test('clamps bbox into the unit square and keeps w/h inside the image', () => {
    const b = validate({ hazards: [{ type_id: 'open_drain', severity: 3, bbox: { x: 0.9, y: -0.5, w: 0.8, h: 3 } }] }).hazards[0].bbox;
    assert.equal(b.x, 0.9); assert.equal(b.y, 0);
    assert.ok(b.x + b.w <= 1.0001, 'w clamped so x+w<=1');
    assert.ok(b.y + b.h <= 1.0001, 'h clamped so y+h<=1');
    assert.ok(b.w >= 0.01 && b.h >= 0.01);
  });
  test('missing bbox gets a small default box', () => {
    const b = validate({ hazards: [{ type_id: 'open_drain', severity: 3 }] }).hazards[0].bbox;
    assert.deepEqual(b, { x: 0, y: 0, w: 0.05, h: 0.05 });
  });
  test('null width stays null; bad width becomes null; big width clamps to 10', () => {
    assert.equal(validate({ hazards: [], estimated_clear_width_m: null }).estimated_clear_width_m, null);
    assert.equal(validate({ hazards: [] }).estimated_clear_width_m, null);
    assert.equal(validate({ hazards: [], estimated_clear_width_m: 'wide' }).estimated_clear_width_m, null);
    assert.equal(validate({ hazards: [], estimated_clear_width_m: 40 }).estimated_clear_width_m, 10);
    assert.equal(validate({ hazards: [], estimated_clear_width_m: '1.5' }).estimated_clear_width_m, 1.5);
  });
  test('unknown surface becomes none; note and observations are length-capped', () => {
    const v = validate({ surface_type: 'lava', hazards: [{ type_id: 'open_drain', severity: 3, note: 'x'.repeat(500) }], observations: 'y'.repeat(1000) });
    assert.equal(v.surface_type, 'none');
    assert.equal(v.hazards[0].note.length, 200);
    assert.equal(v.observations.length, 400);
  });
});

describe('analysePhoto (mock mode, temp cache)', () => {
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rasta-test-photo-bytes')]);

  test('module is in mock mode', () => { assert.equal(MOCK, true); });

  test('returns a validated result flagged mock, with a sha256 hash and no error', async () => {
    const r = await analysePhoto(fakeJpeg);
    assert.equal(r.meta.mock, true);
    assert.equal(r.meta.cached, false);
    assert.equal(r.meta.hash, sha256(fakeJpeg));
    assert.equal(r.meta.error, undefined);
    assert.ok(Array.isArray(r.hazards) && r.hazards.length >= 1 && r.hazards.length <= 3);
    for (const h of r.hazards) {
      assert.ok(h.severity >= 1 && h.severity <= 5);
      assert.ok(h.bbox.x + h.bbox.w <= 1.0001);
    }
    assert.ok(r.estimated_clear_width_m > 0);
  });

  test('is deterministic for the same bytes', async () => {
    const a = await analysePhoto(fakeJpeg);
    const b = await analysePhoto(fakeJpeg);
    assert.deepEqual(a.hazards, b.hazards);
  });

  test('a cache file for the hash is returned as a cache hit before mock or model run', async () => {
    const buf = Buffer.from('another-photo');
    const hash = sha256(buf);
    const cached = { ...GOOD, meta: { hash, model: 'claude-fable-5-1', mock: false, latency_ms: 1234 } };
    fs.writeFileSync(path.join(process.env.RASTA_VISION_CACHE_DIR, `${hash}.json`), JSON.stringify(cached));
    const r = await analysePhoto(buf);
    assert.equal(r.meta.cached, true);
    assert.equal(r.meta.model, 'claude-fable-5-1');
    assert.deepEqual(r.hazards, GOOD.hazards);
  });

  test('accepts a file path as well as a Buffer', async () => {
    const p = path.join(process.env.RASTA_VISION_CACHE_DIR, 'photo.jpg');
    fs.writeFileSync(p, fakeJpeg);
    const r = await analysePhoto(p);
    assert.equal(r.meta.hash, sha256(fakeJpeg));
  });
});
