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

db.exec(`
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
`);

// additive migrations for databases created before these columns existed
const cols = new Set(db.prepare(`PRAGMA table_info(segments)`).all().map((c) => c.name));
const addCol = (name, type) => { if (!cols.has(name)) db.exec(`ALTER TABLE segments ADD COLUMN ${name} ${type}`); };
addCol('source', "TEXT DEFAULT 'walk'");
addCol('osm_id', 'INTEGER');
addCol('geometry', 'TEXT');
addCol('tags', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_segments_osm ON segments(osm_id)`);

const q = {
  insertSegment: db.prepare(`INSERT INTO segments
    (name, start_lat, start_lng, end_lat, end_lng, length_m, score, walk_ok, wheelchair_ok, senior_ok,
     walk_reason, wheelchair_reason, senior_reason, clear_width_m, surface_type, total_cost_inr, created_at,
     source, osm_id, geometry, tags)
    VALUES (@name, @start_lat, @start_lng, @end_lat, @end_lng, @length_m, @score, @walk_ok, @wheelchair_ok, @senior_ok,
     @walk_reason, @wheelchair_reason, @senior_reason, @clear_width_m, @surface_type, @total_cost_inr, @created_at,
     @source, @osm_id, @geometry, @tags)`),
  osmIds: db.prepare(`SELECT osm_id FROM segments WHERE osm_id IS NOT NULL`),
  insertPhoto: db.prepare(`INSERT INTO photos (segment_id, filename, hash, width_m, observations, status, created_at)
    VALUES (@segment_id, @filename, @hash, @width_m, @observations, @status, @created_at)`),
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
};

const now = () => new Date().toISOString();

/** Persist a fully graded segment (output of scoring.gradeSegment) plus its photos and hazards. */
const saveSegment = db.transaction((graded, photos) => {
  const info = q.insertSegment.run({
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
    created_at: graded.created_at || now(),
    source: graded.source || 'walk',
    osm_id: graded.osm_id || null,
    geometry: graded.geometry ? JSON.stringify(graded.geometry) : null,
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
      created_at: now(),
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

function rowToSegment(row) {
  return {
    id: row.id,
    name: row.name,
    start: { lat: row.start_lat, lng: row.start_lng },
    end: { lat: row.end_lat, lng: row.end_lng },
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
    geometry: row.geometry ? JSON.parse(row.geometry) : null, // [[lng,lat],...]
    tags: row.tags ? JSON.parse(row.tags) : null,
  };
}

function getSegment(id) {
  const row = q.segment.get(id);
  if (!row) return null;
  const photos = q.photosFor.all(id).map((p) => ({
    id: p.id,
    url: p.filename ? `/uploads/${p.filename}` : null,
    width_m: p.width_m,
    observations: p.observations,
    status: p.status,
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

function toGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: q.allSegments.all().map((row) => ({
      type: 'Feature',
      id: row.id,
      geometry: { type: 'LineString', coordinates: row.geometry ? JSON.parse(row.geometry) : [[row.start_lng, row.start_lat], [row.end_lng, row.end_lat]] },
      properties: (() => { const p = rowToSegment(row); delete p.geometry; delete p.tags; return p; })(),
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

function knownOsmIds() { return new Set(q.osmIds.all().map((r) => r.osm_id)); }

module.exports = { db, saveSegment, getSegment, allSegments, toGeoJSON, stats, isEmpty, knownOsmIds };
