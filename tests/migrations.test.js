// tests/migrations.test.js — the schema_version runner: fresh, legacy (pre-runner) and re-run cases.
process.env.RASTA_DB = ':memory:';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate, MIGRATIONS } = require('../db');

const cols = (conn, table) => conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const tables = (conn) => conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((r) => r.name);
const version = (conn) => conn.prepare(`SELECT MAX(version) AS v FROM schema_version`).get().v;

describe('migrate', () => {
  test('a fresh database gets every migration and ends at the latest version', () => {
    const conn = new Database(':memory:');
    const r = migrate(conn);
    assert.deepEqual(r.applied, MIGRATIONS.map((_, i) => i + 1));
    assert.equal(version(conn), MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 2);
    assert.ok(tables(conn).includes('vision_calls'));
    assert.ok(cols(conn, 'segments').includes('geometry'));
    for (const c of ['photo_lat', 'photo_lng', 'taken_at']) assert.ok(cols(conn, 'photos').includes(c), c);
    assert.ok(cols(conn, 'vision_calls').includes('result'));
  });

  test('a hackathon-era database (tables, no schema_version) is baselined at 1 and then migrated', () => {
    const conn = new Database(':memory:');
    conn.exec(MIGRATIONS[0]); // exactly what the old db.js created
    assert.equal(cols(conn, 'segments').includes('geometry'), false);
    const r = migrate(conn);
    assert.deepEqual(r.applied, MIGRATIONS.slice(1).map((_, i) => i + 2), 'migration 1 was not re-run');
    assert.equal(version(conn), MIGRATIONS.length);
    assert.ok(cols(conn, 'segments').includes('geometry'));
    assert.equal(conn.prepare(`SELECT COUNT(*) AS n FROM schema_version`).get().n, MIGRATIONS.length);
  });

  test('a database that already has the Phase 3 vision_calls table (no result column) migrates cleanly', () => {
    const conn = new Database(':memory:');
    conn.exec(MIGRATIONS[0]);
    conn.exec(`CREATE TABLE vision_calls (id INTEGER PRIMARY KEY, hash TEXT, model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, latency_ms INTEGER, cached INTEGER DEFAULT 0, error TEXT, created_at TEXT)`);
    conn.prepare(`INSERT INTO vision_calls (hash, model, created_at) VALUES ('h', 'm', 'now')`).run();
    migrate(conn);
    assert.ok(cols(conn, 'vision_calls').includes('result'));
    assert.equal(conn.prepare(`SELECT COUNT(*) AS n FROM vision_calls`).get().n, 1, 'existing rows kept');
  });

  test('running again is a no-op', () => {
    const conn = new Database(':memory:');
    migrate(conn);
    const r = migrate(conn);
    assert.deepEqual(r.applied, []);
    assert.equal(conn.prepare(`SELECT COUNT(*) AS n FROM schema_version`).get().n, MIGRATIONS.length);
  });

  test('a failing migration rolls back and leaves the version untouched', () => {
    const conn = new Database(':memory:');
    migrate(conn, [MIGRATIONS[0]]);
    assert.throws(() => migrate(conn, [MIGRATIONS[0], `CREATE TABLE will_exist (id INTEGER); CREATE TABLE segments (id INTEGER)`]), /migration 2 failed/);
    assert.equal(version(conn), 1);
    assert.equal(tables(conn).includes('will_exist'), false, 'partial migration rolled back');
  });

  test('duplicate ALTER TABLE ADD COLUMN is tolerated, other errors are not', () => {
    const conn = new Database(':memory:');
    migrate(conn, [MIGRATIONS[0]]);
    migrate(conn, [MIGRATIONS[0], `ALTER TABLE segments ADD COLUMN extra TEXT; ALTER TABLE segments ADD COLUMN extra TEXT`]);
    assert.ok(cols(conn, 'segments').includes('extra'));
    assert.throws(() => migrate(conn, [MIGRATIONS[0], '', `SELECT * FROM no_such_table`]), /no such table/);
  });
});
