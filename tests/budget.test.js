// tests/budget.test.js — with a (fake) key set, mock mode is off; the daily token budget must
// stop uncached photos before any network call is made.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.RASTA_DB = ':memory:';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-never-used';
delete process.env.RASTA_MOCK_VISION;
process.env.RASTA_DAILY_TOKEN_BUDGET = '1000';
process.env.RASTA_VISION_CONCURRENCY = '2';
process.env.RASTA_VISION_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rasta-vc-'));

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const vision = require('../vision');

after(() => fs.rmSync(process.env.RASTA_VISION_CACHE_DIR, { recursive: true, force: true }));

describe('daily token budget', () => {
  test('module is live (not mock) with the budget and concurrency from env', () => {
    assert.equal(vision.MOCK, false);
    assert.equal(vision.DAILY_BUDGET, 1000);
    assert.equal(vision.CONCURRENCY, 2);
    assert.equal(vision.usage().budget_reached, false);
  });

  test('once today\'s tokens pass the budget, an uncached photo returns zero hazards with meta.error and no model call', async () => {
    db.recordVisionCall({ hash: 'earlier', model: vision.MODEL, input_tokens: 800, output_tokens: 300, latency_ms: 900 });
    assert.equal(vision.usage().today.tokens, 1100);
    assert.equal(vision.usage().budget_reached, true);

    const before = db.visionUsage().total.calls;
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('budget-test-photo')]);
    const t0 = Date.now();
    const r = await vision.analysePhoto(buf);
    assert.ok(Date.now() - t0 < 500, 'returned immediately — no network round-trip');
    assert.equal(r.meta.error, vision.BUDGET_ERROR);
    assert.equal(r.meta.error, 'daily budget reached');
    assert.deepEqual(r.hazards, []);
    assert.equal(r.meta.mock, false);
    assert.equal(r.meta.cached, false);
    assert.equal(r.meta.hash, vision.sha256(buf));

    const after = db.visionUsage();
    assert.equal(after.total.calls, before + 1, 'the skip is recorded');
    assert.equal(after.total.errors, 1);
    assert.equal(after.total.tokens, 1100, 'no tokens were spent');
  });

  test('cache hits still work when the budget is exhausted', async () => {
    const buf = Buffer.from('cached-under-budget');
    const hash = vision.sha256(buf);
    fs.writeFileSync(path.join(process.env.RASTA_VISION_CACHE_DIR, `${hash}.json`), JSON.stringify({ surface_type: 'paver', hazards: [], estimated_clear_width_m: 2, observations: '', meta: { hash, model: vision.MODEL } }));
    const r = await vision.analysePhoto(buf);
    assert.equal(r.meta.cached, true);
    assert.equal(r.meta.error, undefined);
  });

  test('stats endpoint shape: usage() carries budget, in_flight and waiting', () => {
    const u = vision.usage();
    assert.equal(u.budget, 1000);
    assert.equal(u.in_flight, 0);
    assert.equal(u.waiting, 0);
    assert.ok(u.today.cache_hits >= 1);
  });
});
