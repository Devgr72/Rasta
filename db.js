// db.js — SQLite schema and every query the server needs. One file, zero setup.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.RASTA_DB || path.join(__dirname, 'data', 'rasta.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
function openDb() {
  const d = new Database(DB_PATH);
  d.pragma('journal_mode = WAL');
  return d;
}
let db;
try {
  db = openDb();
} catch (err) {
  // A stale -shm/-wal pair left by a killed process makes SQLite report an I/O
  // error on open. If the WAL holds nothing, clearing the pair is safe.
  const wal = `${DB_PATH}-wal`, shm = `${DB_PATH}-shm`;
  const walEmpty = !fs.existsSync(wal) || fs.statSync(wal).size === 0;
  if (/SQLITE_IOERR/.test(err.code || '') && walEmpty) {
    console.warn('[db] stale WAL files, clearing and reopening');
    for (const f of [wal, shm]) { try { fs.unlinkSync(f); } catch {} }
    db = openDb();
  } else throw err;
}
db.pragma('foreign_keys = ON');

// ---------- migrations ----------
// Ordered SQL strings. Each runs once, inside a transaction, and bumps schema_version.
// `ALTER TABLE ... ADD COLUMN` on a column that already exists is tolerated so a migration can
// be re-run safely against a database that was created before the runner existed.
const MIGRATIONS = [
  // 1 — the hackathon schema
  `
  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY,
    name TEXT,
    start_lat REAL, start_lng REAL,
    end_lat REAL, end_lng REAL,
    length_m REAL,
    score INTEGER,
    walk_ok INTEGER,
    wheelchair_ok INTEGER,
    senior_ok INTEGER,
    walk_reason TEXT,
    wheelchair_reason TEXT,
    senior_reason TEXT,
    clear_width_m REAL,
    surface_type TEXT,
    total_cost_inr INTEGER,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    filename TEXT,
    hash TEXT,
    width_m REAL,
    observations TEXT,
    status TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS hazards (
    id INTEGER PRIMARY KEY,
    segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
    type_id TEXT,
    severity INTEGER,
    note TEXT,
    bbox TEXT,
    cost_inr INTEGER,
    authority TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hazards_segment ON hazards(segment_id);
  CREATE INDEX IF NOT EXISTS idx_photos_segment ON photos(segment_id);
  `,
  // 2 — token accounting + DB-backed vision cache, snapped geometry, photo GPS and capture time
  `
  CREATE TABLE IF NOT EXISTS vision_calls (
    id INTEGER PRIMARY KEY,
    hash TEXT,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    latency_ms INTEGER,
    cached INTEGER DEFAULT 0,
    error TEXT,
    created_at TEXT
  );
  ALTER TABLE vision_calls ADD COLUMN result TEXT;
  CREATE INDEX IF NOT EXISTS idx_vision_calls_created ON vision_calls(created_at);
  CREATE INDEX IF NOT EXISTS idx_vision_calls_hash ON vision_calls(hash);
  ALTER TABLE segments ADD COLUMN geometry TEXT;
  ALTER TABLE photos ADD COLUMN photo_lat REAL;
  ALTER TABLE photos ADD COLUMN photo_lng REAL;
  ALTER TABLE photos ADD COLUMN taken_at TEXT;
  `,
  // 3 — bounding box per segment so route scoring only loads segments near the route
  `
  ALTER TABLE segments ADD COLUMN min_lat REAL;
  ALTER TABLE segments ADD COLUMN min_lng REAL;
  ALTER TABLE segments ADD COLUMN max_lat REAL;
  ALTER TABLE segments ADD COLUMN max_lng REAL;
  UPDATE segments SET
    min_lat = MIN(start_lat, end_lat), max_lat = MAX(start_lat, end_lat),
    min_lng = MIN(start_lng, end_lng), max_lng = MAX(start_lng, end_lng)
    WHERE min_lat IS NULL;
  CREATE INDEX IF NOT EXISTS idx_segments_bbox ON segments(min_lat, max_lat, min_lng, max_lng);
  `,
  // 4 — where a reading came from: walked photos, OpenStreetMap tags, or openly licensed photos
  `
  ALTER TABLE segments ADD COLUMN source TEXT DEFAULT 'walk';
  ALTER TABLE segments ADD COLUMN osm_id INTEGER;
  ALTER TABLE segments ADD COLUMN tags TEXT;
  CREATE INDEX IF NOT EXISTS idx_segments_osm ON segments(osm_id);
  ALTER TABLE photos ADD COLUMN credit TEXT;
  ALTER TABLE photos ADD COLUMN license TEXT;
  ALTER TABLE photos ADD COLUMN source_url TEXT;
  ALTER TABLE photos ADD COLUMN source TEXT;
  `,
];

function migrate(conn, migrations = MIGRATIONS) {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)`);
  let version = conn.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`).get().v;
  // A database created before the runner existed has the migration-1 tables but no version row.
  if (version === 0 && conn.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'segments'`).get()) {
    conn.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (1, ?)`).run(new Date().toISOString());
    version = 1;
  }
  const applied = [];
  const runOne = conn.transaction((n, sql) => {
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      try { conn.exec(stmt); } catch (err) {
        if (/duplicate column name/i.test(err.message) && /ALTER TABLE .* ADD COLUMN/i.test(stmt)) continue;
        throw new Error(`migration ${n} failed at "${stmt.slice(0, 60)}…": ${err.message}`);
      }
    }
    conn.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`).run(n, new Date().toISOString());
  });
  for (let n = version + 1; n <= migrations.length; n++) { runOne(n, migrations[n - 1]); applied.push(n); }
  if (applied.length) console.log(`[db] migrated to schema version ${migrations.length} (applied ${applied.join(', ')})`);
  return { version: migrations.length, applied };
}

migrate(db);
repairLegacyGeometry(db);


const q = {
  insertSegment: db.prepare(`INSERT INTO segments
    (name, start_lat, start_lng, end_lat, end_lng, length_m, score, walk_ok, wheelchair_ok, senior_ok,
     walk_reason, wheelchair_reason, senior_reason, clear_width_m, surface_type, total_cost_inr, geometry,
     min_lat, min_lng, max_lat, max_lng, source, osm_id, tags, created_at)
    VALUES (@name, @start_lat, @start_lng, @end_lat, @end_lng, @length_m, @score, @walk_ok, @wheelchair_ok, @senior_ok,
     @walk_reason, @wheelchair_reason, @senior_reason, @clear_width_m, @surface_type, @total_cost_inr, @geometry,
     @min_lat, @min_lng, @max_lat, @max_lng, @source, @osm_id, @tags, @created_at)`),
  segmentsInBbox: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM hazards h WHERE h.segment_id = s.id) AS hazard_count,
    (SELECT COUNT(*) FROM photos p WHERE p.segment_id = s.id) AS photo_count FROM segments s
    WHERE s.max_lat >= @min_lat AND s.min_lat <= @max_lat AND s.max_lng >= @min_lng AND s.min_lng <= @max_lng ORDER BY s.id`),
  osmIds: db.prepare(`SELECT osm_id FROM segments WHERE osm_id IS NOT NULL`),
  insertPhoto: db.prepare(`INSERT INTO photos (segment_id, filename, hash, width_m, observations, status, photo_lat, photo_lng, taken_at, credit, license, source_url, source, created_at)
    VALUES (@segment_id, @filename, @hash, @width_m, @observations, @status, @photo_lat, @photo_lng, @taken_at, @credit, @license, @source_url, @source, @created_at)`),
  cachedResult: db.prepare(`SELECT result FROM vision_calls WHERE hash = ? AND result IS NOT NULL ORDER BY id DESC LIMIT 1`),
  insertHazard: db.prepare(`INSERT INTO hazards (segment_id, photo_id, type_id, severity, note, bbox, cost_inr, authority)
    VALUES (@segment_id, @photo_id, @type_id, @severity, @note, @bbox, @cost_inr, @authority)`),
  allSegments: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM hazards h WHERE h.segment_id = s.id) AS hazard_count,
    (SELECT COUNT(*) FROM photos p WHERE p.segment_id = s.id) AS photo_count FROM segments s ORDER BY s.id`),
  segment: db.prepare(`SELECT * FROM segments WHERE id = ?`),
  photosFor: db.prepare(`SELECT * FROM photos WHERE segment_id = ? ORDER BY id`),
  hazardsFor: db.prepare(`SELECT * FROM hazards WHERE segment_id = ? ORDER BY severity DESC, id`),
  count: db.prepare(`SELECT COUNT(*) AS n FROM segments`),
  stats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM segments WHERE source = 'walk' OR source IS NULL) AS segments,
    (SELECT COUNT(*) FROM segments WHERE source = 'osm') AS open_data_segments,
    (SELECT COUNT(*) FROM photos WHERE filename IS NOT NULL) AS photos,
    (SELECT COUNT(*) FROM hazards) AS hazards,
    (SELECT COALESCE(SUM(length_m), 0) FROM segments) AS metres,
    (SELECT COALESCE(AVG(score), 0) FROM segments) AS avg_score,
    (SELECT COALESCE(SUM(total_cost_inr), 0) FROM segments) AS total_cost_inr,
    (SELECT COUNT(*) FROM segments WHERE wheelchair_ok = 1) AS wheelchair_ok_count,
    (SELECT COUNT(*) FROM segments WHERE senior_ok = 1) AS senior_ok_count`),
  insertVisionCall: db.prepare(`INSERT INTO vision_calls (hash, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, cached, error, result, created_at)
    VALUES (@hash, @model, @input_tokens, @output_tokens, @cache_read_tokens, @latency_ms, @cached, @error, @result, @created_at)`),
  visionUsageSince: db.prepare(`SELECT COUNT(*) AS calls,
    COALESCE(SUM(CASE WHEN cached = 0 AND error IS NULL AND model != 'mock' THEN 1 ELSE 0 END), 0) AS model_calls,
    COALESCE(SUM(CASE WHEN model = 'mock' THEN 1 ELSE 0 END), 0) AS mock_calls,
    COALESCE(SUM(cached), 0) AS cache_hits,
    COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
    FROM vision_calls WHERE created_at >= ?`),
  deleteSegment: db.prepare(`DELETE FROM segments WHERE id = ?`),
  filenamesFor: db.prepare(`SELECT filename FROM photos WHERE segment_id = ? AND filename IS NOT NULL`),
  filenameRefs: db.prepare(`SELECT COUNT(*) AS n FROM photos WHERE filename = ?`),
};

const now = () => new Date().toISOString();

/** Persist a fully graded segment (output of scoring.gradeSegment) plus its photos and hazards. */
const saveSegment = db.transaction((graded, photos) => {
  const coords = graded.geometry && Array.isArray(graded.geometry.coordinates) && graded.geometry.coordinates.length >= 2
    ? graded.geometry.coordinates : [[graded.start.lng, graded.start.lat], [graded.end.lng, graded.end.lat]];
  const bbox = { min_lat: Infinity, min_lng: Infinity, max_lat: -Infinity, max_lng: -Infinity };
  for (const [lng, lat] of coords) {
    bbox.min_lat = Math.min(bbox.min_lat, lat); bbox.max_lat = Math.max(bbox.max_lat, lat);
    bbox.min_lng = Math.min(bbox.min_lng, lng); bbox.max_lng = Math.max(bbox.max_lng, lng);
  }
  const info = q.insertSegment.run({
    ...bbox,
    name: graded.name,
    start_lat: graded.start.lat, start_lng: graded.start.lng,
    end_lat: graded.end.lat, end_lng: graded.end.lng,
    length_m: graded.length_m,
    score: graded.score,
    walk_ok: graded.verdicts.walk.ok ? 1 : 0,
    wheelchair_ok: graded.verdicts.wheelchair.ok ? 1 : 0,
    senior_ok: graded.verdicts.senior.ok ? 1 : 0,
    walk_reason: graded.verdicts.walk.reason,
    wheelchair_reason: graded.verdicts.wheelchair.reason,
    senior_reason: graded.verdicts.senior.reason,
    clear_width_m: graded.clear_width_m,
    surface_type: graded.surface_type,
    total_cost_inr: graded.total_cost_inr,
    geometry: graded.geometry ? JSON.stringify(graded.geometry) : null, // GeoJSON LineString, snapped to the footway when available
    created_at: graded.created_at || now(),
    source: graded.source || 'walk',
    osm_id: graded.osm_id || null,
    tags: graded.tags ? JSON.stringify(graded.tags) : null,
  });
  const segmentId = Number(info.lastInsertRowid);
  for (const p of photos) {
    const pi = q.insertPhoto.run({
      segment_id: segmentId,
      filename: p.filename || null,
      hash: p.hash || null,
      width_m: p.estimated_clear_width_m ?? null,
      observations: p.observations || '',
      status: p.status || 'ok',
      photo_lat: Number.isFinite(p.photo_lat) ? p.photo_lat : null,
      photo_lng: Number.isFinite(p.photo_lng) ? p.photo_lng : null,
      taken_at: p.taken_at || null,
      created_at: now(),
      credit: p.credit || null,
      license: p.license || null,
      source_url: p.source_url || null,
      source: p.source || null,
    });
    const photoId = Number(pi.lastInsertRowid);
    for (const h of p.hazards || []) {
      q.insertHazard.run({
        segment_id: segmentId,
        photo_id: photoId,
        type_id: h.type_id,
        severity: h.severity,
        note: h.note || '',
        bbox: JSON.stringify(h.bbox || null),
        cost_inr: h.cost_inr || 0,
        authority: h.authority || null,
      });
    }
  }
  return segmentId;
});

// How a stored filename becomes a URL. The server swaps this for the storage driver's builder
// (local /uploads/... or an S3 public URL). db.js itself stays storage-agnostic.
let urlFor = (filename) => `/uploads/${filename}`;
function setUrlBuilder(fn) { urlFor = fn; }

function parseGeometry(row) {
  if (row.geometry) {
    try {
      const g = JSON.parse(row.geometry);
      // rows written before geometry was unified stored a bare [[lng,lat],...] list
      if (Array.isArray(g)) return { type: 'LineString', coordinates: g };
      if (g && Array.isArray(g.coordinates)) return g;
    } catch { /* fall through */ }
  }
  return { type: 'LineString', coordinates: [[row.start_lng, row.start_lat], [row.end_lng, row.end_lat]] };
}

// One-off repair for rows written by the first OpenStreetMap import: wrap bare coordinate lists
// as GeoJSON and widen the bbox to the whole polyline so the spatial pre-filter finds them.
function repairLegacyGeometry(conn) {
  const rows = conn.prepare(`SELECT id, geometry FROM segments WHERE geometry LIKE '[%'`).all();
  if (!rows.length) return 0;
  const upd = conn.prepare(`UPDATE segments SET geometry = @geometry, min_lat = @min_lat, max_lat = @max_lat, min_lng = @min_lng, max_lng = @max_lng WHERE id = @id`);
  const tx = conn.transaction((list) => {
    for (const r of list) {
      let coords; try { coords = JSON.parse(r.geometry); } catch { continue; }
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const lats = coords.map((c) => c[1]), lngs = coords.map((c) => c[0]);
      upd.run({ id: r.id, geometry: JSON.stringify({ type: 'LineString', coordinates: coords }), min_lat: Math.min(...lats), max_lat: Math.max(...lats), min_lng: Math.min(...lngs), max_lng: Math.max(...lngs) });
    }
  });
  tx(rows);
  console.log(`[db] repaired geometry on ${rows.length} legacy segment(s)`);
  return rows.length;
}

function rowToSegment(row) {
  return {
    id: row.id,
    name: row.name,
    start: { lat: row.start_lat, lng: row.start_lng },
    end: { lat: row.end_lat, lng: row.end_lng },
    geometry: parseGeometry(row),
    length_m: row.length_m,
    score: row.score,
    clear_width_m: row.clear_width_m,
    surface_type: row.surface_type,
    total_cost_inr: row.total_cost_inr,
    verdicts: {
      walk: { ok: !!row.walk_ok, reason: row.walk_reason },
      wheelchair: { ok: !!row.wheelchair_ok, reason: row.wheelchair_reason },
      senior: { ok: !!row.senior_ok, reason: row.senior_reason },
    },
    hazard_count: row.hazard_count,
    photo_count: row.photo_count,
    created_at: row.created_at,
    source: row.source || 'walk',
    osm_id: row.osm_id || null,
    tags: row.tags ? JSON.parse(row.tags) : null,
  };
}

function getSegment(id) {
  const row = q.segment.get(id);
  if (!row) return null;
  const photos = q.photosFor.all(id).map((p) => ({
    id: p.id,
    url: p.filename ? urlFor(p.filename) : null,
    width_m: p.width_m,
    observations: p.observations,
    status: p.status,
    lat: p.photo_lat,
    lng: p.photo_lng,
    taken_at: p.taken_at,
    credit: p.credit,
    license: p.license,
    source_url: p.source_url,
    source: p.source,
  }));
  const hazards = q.hazardsFor.all(id).map((h) => ({
    id: h.id,
    photo_id: h.photo_id,
    type_id: h.type_id,
    severity: h.severity,
    note: h.note,
    bbox: h.bbox ? JSON.parse(h.bbox) : null,
    cost_inr: h.cost_inr,
    authority: h.authority,
  }));
  return { ...rowToSegment({ ...row, hazard_count: hazards.length, photo_count: photos.length }), photos, hazards };
}

function allSegments() {
  return q.allSegments.all().map(rowToSegment);
}

/** Segments whose bounding box intersects the given one — the spatial pre-filter for route scoring. */
function segmentsInBbox(bbox) {
  return q.segmentsInBbox.all(bbox).map(rowToSegment);
}

function toGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: q.allSegments.all().map((row) => ({
      type: 'Feature',
      id: row.id,
      geometry: parseGeometry(row),
      properties: (() => { const p = rowToSegment(row); delete p.tags; return p; })(),
    })),
  };
}

function stats() {
  const s = q.stats.get();
  return {
    segments: s.segments,
    open_data_segments: s.open_data_segments,
    photos: s.photos,
    hazards: s.hazards,
    km_covered: +(s.metres / 1000).toFixed(2),
    avg_score: Math.round(s.avg_score),
    total_cost_inr: s.total_cost_inr,
    wheelchair_ok_count: s.wheelchair_ok_count,
    senior_ok_count: s.senior_ok_count,
  };
}

function isEmpty() {
  return q.count.get().n === 0;
}

/**
 * Record one vision call (model call, cache hit, mock or failure) for budgeting and stats.
 * Pass `result` (the validated contract object) on a successful model call to make it the cache entry for that hash.
 */
function recordVisionCall({ hash, model, input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, latency_ms = null, cached = false, error = null, result = null }) {
  try {
    q.insertVisionCall.run({
      hash: hash || null, model: model || null,
      input_tokens: Math.max(0, Math.round(Number(input_tokens) || 0)),
      output_tokens: Math.max(0, Math.round(Number(output_tokens) || 0)),
      cache_read_tokens: Math.max(0, Math.round(Number(cache_read_tokens) || 0)),
      latency_ms: latency_ms == null ? null : Math.round(latency_ms),
      cached: cached ? 1 : 0, error: error ? String(error).slice(0, 300) : null,
      result: result ? JSON.stringify(result) : null,
      created_at: now(),
    });
  } catch (err) { console.warn('[db] vision_calls insert failed', err.message); }
}

/** The most recent successful vision result for a photo hash — one indexed read. */
function cachedVisionResult(hash) {
  const row = q.cachedResult.get(hash);
  if (!row) return null;
  try { return JSON.parse(row.result); } catch { return null; }
}

const startOfUtcDay = () => new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

/** Token usage today (UTC) and all time. `tokens` is input + output, the number a budget is set against. */
function visionUsage() {
  const shape = (r) => ({ ...r, tokens: r.input_tokens + r.output_tokens });
  return { today: shape(q.visionUsageSince.get(startOfUtcDay())), total: shape(q.visionUsageSince.get('')) };
}

/**
 * Delete a segment (photos and hazards cascade). Returns the upload filenames that
 * no other segment still references, so the caller can remove the files.
 */
const deleteSegment = db.transaction((id) => {
  const files = q.filenamesFor.all(id).map((r) => r.filename);
  const info = q.deleteSegment.run(id);
  if (!info.changes) return null;
  const orphaned = files.filter((f) => q.filenameRefs.get(f).n === 0);
  return { id, orphaned_files: [...new Set(orphaned)] };
});

/** OSM way ids already imported, so an import never duplicates a way. */
function knownOsmIds() { return new Set(q.osmIds.all().map((r) => r.osm_id)); }

module.exports = {
  db, migrate, MIGRATIONS, setUrlBuilder,
  saveSegment, getSegment, allSegments, segmentsInBbox, toGeoJSON, stats, isEmpty, deleteSegment, knownOsmIds,
  recordVisionCall, cachedVisionResult, visionUsage,
};
