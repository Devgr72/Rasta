// server.js — Express app, all routes. Static frontend from /public.
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const scoring = require('./scoring');
const vision = require('./vision');

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OSRM_BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '30d', immutable: true }));
app.use('/vendor/maplibre', express.static(path.join(__dirname, 'node_modules', 'maplibre-gl', 'dist'), { maxAge: '30d', immutable: true }));
app.use('/vendor/googlemutant', express.static(path.join(__dirname, 'node_modules', 'leaflet.gridlayer.googlemutant', 'dist'), { maxAge: '30d', immutable: true }));
app.use('/vendor/maplibre-leaflet', express.static(path.join(__dirname, 'node_modules', '@maplibre', 'maplibre-gl-leaflet'), { maxAge: '30d', immutable: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 12, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// ---------- helpers ----------
const num = (v) => (v === '' || v == null ? NaN : Number(v));
function parsePoint(p) {
  if (!p) return null;
  const lat = num(p.lat), lng = num(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
function extFor(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return 'jpg';
}
function dataUrlToBuffer(s) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(s || ''));
  return m ? Buffer.from(m[2], 'base64') : null;
}
function fail(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

// Photos arrive either as multipart files or as base64 data URLs in JSON.
function collectPhotoBuffers(req) {
  const out = [];
  for (const f of req.files || []) out.push(f.buffer);
  const body = req.body || {};
  const list = Array.isArray(body.photos) ? body.photos : [];
  for (const p of list) {
    const b = dataUrlToBuffer(typeof p === 'string' ? p : p && p.data);
    if (b) out.push(b);
  }
  return out;
}

async function analyseAndSave({ name, start, end }, buffers, onPhoto) {
  // all photos in parallel — one API call each
  const results = await Promise.all(buffers.map(async (buf, i) => {
    let r;
    try {
      r = await vision.analysePhoto(buf);
    } catch (err) {
      console.error('[vision] unexpected throw', err);
      r = { ...vision.validate({ hazards: [] }), meta: { hash: vision.sha256(buf), error: err.message } };
    }
    const filename = `${r.meta.hash.slice(0, 16)}.${extFor(buf)}`;
    const dest = path.join(UPLOAD_DIR, filename);
    try { if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf); } catch (err) { console.warn('[upload] write failed', err.message); }
    const photo = {
      index: i,
      filename,
      url: `/uploads/${filename}`,
      hash: r.meta.hash,
      hazards: r.hazards.map(scoring.enrichHazard).filter(Boolean),
      estimated_clear_width_m: r.estimated_clear_width_m,
      surface_type: r.surface_type,
      observations: r.observations,
      status: r.meta.error ? 'failed' : r.meta.mock ? 'mock' : 'ok',
      error: r.meta.error || null,
      latency_ms: r.meta.latency_ms,
      cached: !!r.meta.cached,
    };
    if (onPhoto) onPhoto(photo);
    return photo;
  }));

  const graded = scoring.gradeSegment({ name, start, end }, results);
  const id = db.saveSegment(graded, results.map((p) => ({ ...p, hazards: p.hazards })));
  return { ...db.getSegment(id), cost_by_authority: graded.cost_by_authority, photo_results: results };
}

// ---------- API ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, model: vision.MODEL, mock: vision.MOCK }));

// Public-safe config for the browser. The Google key is meant to be exposed
// (restrict it by HTTP referrer in Google Cloud); the Anthropic key never is.
app.get('/api/config', (_req, res) => res.json({ google_maps_key: process.env.GOOGLE_MAPS_KEY || null }));

// Segments near a point, nearest first. Powers "already mapped here".
app.get('/api/segments/near', (req, res) => {
  const p = parsePoint({ lat: req.query.lat, lng: req.query.lng });
  const r = Math.min(500, Math.max(10, Number(req.query.r) || 80));
  if (!p) return fail(res, 400, 'lat and lng required');
  try {
    const out = [];
    for (const s of db.allSegments()) {
      const pts = s.geometry ? s.geometry.map(([lng, lat]) => ({ lat, lng })) : [s.start, s.end];
      const d = scoring.distanceToLine(p, pts);
      if (d <= r) out.push({ ...s, geometry: undefined, tags: undefined, distance_m: Math.round(d) });
    }
    out.sort((a, b) => a.distance_m - b.distance_m);
    res.json({ ok: true, count: out.length, segments: out.slice(0, 20) });
  } catch (err) { fail(res, 500, err.message); }
});

app.get('/api/standards', (_req, res) => res.json(scoring.STANDARDS));

app.get('/api/stats', (_req, res) => {
  try { res.json(db.stats()); } catch (err) { fail(res, 500, err.message); }
});

app.get('/api/segments', (_req, res) => {
  try { res.json(db.toGeoJSON()); } catch (err) { fail(res, 500, err.message); }
});

app.get('/api/segments/:id', (req, res) => {
  try {
    const seg = db.getSegment(Number(req.params.id));
    if (!seg) return fail(res, 404, 'segment not found');
    res.json(seg);
  } catch (err) { fail(res, 500, err.message); }
});

// POST /api/segments — multipart (fields + photos[]) or JSON {name,start,end,photos:[dataURL]}.
// Add ?stream=1 to receive NDJSON: one {type:"photo"} line per result as it lands, then {type:"segment"}.
app.post('/api/segments', upload.array('photos', 12), async (req, res) => {
  const body = req.body || {};
  let start = parsePoint(body.start ? (typeof body.start === 'string' ? JSON.parse(body.start) : body.start) : { lat: body.start_lat, lng: body.start_lng });
  let end = parsePoint(body.end ? (typeof body.end === 'string' ? JSON.parse(body.end) : body.end) : { lat: body.end_lat, lng: body.end_lng });
  const name = String(body.name || '').trim().slice(0, 120) || 'Unnamed footpath';
  if (!start || !end) return fail(res, 400, 'start and end must be {lat,lng}');
  const buffers = collectPhotoBuffers(req);
  if (!buffers.length) return fail(res, 400, 'attach at least one photo');

  const stream = req.query.stream === '1';
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write(JSON.stringify({ type: 'start', photos: buffers.length, model: vision.MODEL, mock: vision.MOCK }) + '\n');
  }
  try {
    const segment = await analyseAndSave({ name, start, end }, buffers, stream ? (p) => res.write(JSON.stringify({ type: 'photo', photo: p }) + '\n') : null);
    console.log(`[segment] #${segment.id} "${segment.name}" score ${segment.score}, ${segment.hazards.length} hazards`);
    if (stream) { res.write(JSON.stringify({ type: 'segment', segment }) + '\n'); return res.end(); }
    res.status(201).json(segment);
  } catch (err) {
    console.error('[segment] failed', err);
    if (stream) { res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n'); return res.end(); }
    fail(res, 500, `analysis failed: ${err.message}`);
  }
});

// ---------- open data: OpenStreetMap via Overpass ----------
const OVERPASS = [process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'rasta-footpath-map/0.1 (+https://github.com/Devgr72/Rasta)';

async function queryOverpass(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const q = `[out:json][timeout:25];(
    way["highway"~"^(footway|path|pedestrian|steps|living_street)$"](${b});
    way["footway"="sidewalk"](${b});
    way["highway"~"^(residential|tertiary|secondary|primary|unclassified|trunk)$"]["sidewalk"](${b});
  );out geom;`;
  let lastErr;
  for (const url of OVERPASS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': UA }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`Overpass ${r.status}`);
      return await r.json();
    } catch (err) { lastErr = err; console.warn('[osm]', url, err.message); }
    finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('Overpass unavailable');
}

// POST /api/import/osm {south,west,north,east} -> grades every way in the box
// whose tags say something about accessibility, stores them as source='osm'.
app.post('/api/import/osm', async (req, res) => {
  const b = req.body || {};
  const bbox = { south: num(b.south), west: num(b.west), north: num(b.north), east: num(b.east) };
  if (Object.values(bbox).some((v) => !Number.isFinite(v)) || bbox.north <= bbox.south || bbox.east <= bbox.west) return fail(res, 400, 'bbox {south,west,north,east} required');
  const area = (bbox.north - bbox.south) * (bbox.east - bbox.west);
  if (area > 0.03) return fail(res, 400, 'Zoom in a little: the area is too large to import in one go (max about 5 km across)');
  try {
    const t0 = Date.now();
    const data = await queryOverpass(bbox);
    const known = db.knownOsmIds();
    let imported = 0, skipped = 0, silent = 0;
    for (const w of (data.elements || []).filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 2)) {
      if (known.has(w.id)) { skipped++; continue; }
      const obs = scoring.tagsToObservation(w.tags || {});
      if (!obs) { silent++; continue; }
      const geometry = w.geometry.map((g) => [g.lon, g.lat]);
      const start = { lat: geometry[0][1], lng: geometry[0][0] };
      const end = { lat: geometry.at(-1)[1], lng: geometry.at(-1)[0] };
      const kind = w.tags.highway === 'steps' ? 'Steps' : w.tags.footway === 'sidewalk' ? 'Footpath' : /footway|path|pedestrian/.test(w.tags.highway) ? 'Footway' : 'Road';
      const name = w.tags.name ? `${w.tags.name} (${kind.toLowerCase()})` : `${kind} near ${start.lat.toFixed(4)}, ${start.lng.toFixed(4)}`;
      const photo = { ...obs, hazards: obs.hazards.map(scoring.enrichHazard).filter(Boolean), status: 'osm', filename: null };
      const graded = scoring.gradeSegment({ name, start, end, geometry, source: 'osm', osm_id: w.id, tags: w.tags }, [photo]);
      if (graded.length_m < 15) { silent++; continue; }
      db.saveSegment(graded, [photo]);
      known.add(w.id); imported++;
      if (imported >= 400) break;
    }
    console.log(`[osm] imported ${imported}, already had ${skipped}, no accessibility tags ${silent}, ${Date.now() - t0}ms`);
    res.json({ ok: true, imported, already_known: skipped, without_tags: silent, ways_seen: (data.elements || []).length });
  } catch (err) {
    console.error('[osm] import failed', err.message);
    fail(res, 502, `OpenStreetMap import failed: ${err.message}`);
  }
});

// ---------- routing ----------
let demoRoute = null;
try { demoRoute = require('./data/demo-route.json'); } catch { console.warn('[route] no data/demo-route.json'); }

async function fetchProfile(profile, from, to, signal) {
  const url = `${OSRM_BASE}/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?alternatives=3&overview=full&geometries=geojson&steps=false`;
  const r = await fetch(url, { signal, headers: { 'User-Agent': 'rasta-footpath-map/0.1' } });
  if (!r.ok) throw new Error(`OSRM ${profile} ${r.status}`);
  const json = await r.json();
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(`OSRM ${profile} ${json.code || 'no routes'}`);
  return json.routes;
}

// The public foot profile almost never returns alternatives, so we ask the
// driving profile too and keep any route whose length differs by over 4%.
async function fetchOSRM(from, to) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const settled = await Promise.allSettled(['foot', 'driving'].map((p) => fetchProfile(p, from, to, ctrl.signal)));
    const routes = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') { console.warn('[route]', s.reason.message); continue; }
      for (const r of s.value) {
        if (!routes.some((x) => Math.abs(x.distance - r.distance) / r.distance < 0.04)) routes.push(r);
      }
    }
    if (!routes.length) throw new Error('OSRM returned no routes');
    return { json: { code: 'Ok', routes: routes.slice(0, 4) }, source: 'osrm' };
  } finally { clearTimeout(timer); }
}

app.post('/api/route', async (req, res) => {
  const from = parsePoint(req.body?.from), to = parsePoint(req.body?.to);
  const persona = ['walk', 'wheelchair', 'senior'].includes(req.body?.persona) ? req.body.persona : 'walk';
  if (!from || !to) return fail(res, 400, 'from and to must be {lat,lng}');
  let osrm, source, warning = null;
  try {
    ({ json: osrm, source } = await fetchOSRM(from, to));
  } catch (err) {
    console.warn('[route] OSRM failed, using cached demo route:', err.message);
    if (!demoRoute) return fail(res, 502, 'routing service unavailable and no cached route');
    osrm = demoRoute; source = 'cached'; warning = 'Live routing unavailable, showing the cached demo route';
  }
  const segments = db.allSegments();
  const routes = osrm.routes.map((r, i) => {
    const scored = scoring.scoreRoute(r.geometry.coordinates, segments);
    const hazardsOn = scored.segments.flatMap((s) => db.getSegment(s.id).hazards.map((h) => ({ ...h, segment_name: s.name })));
    const worst = hazardsOn.sort((a, b) => b.severity - a.severity)[0] || null;
    const personaFails = scored.segments.filter((s) => !s.verdicts[persona].ok);
    return {
      index: i,
      geometry: r.geometry,
      distance_m: Math.round(r.distance),
      duration_min: Math.round(r.duration / 60),
      score: scored.score,
      coverage: scored.coverage,
      segments: scored.segments.map((s) => ({ id: s.id, name: s.name, score: s.score, verdict: s.verdicts[persona] })),
      persona_blockers: personaFails.map((s) => ({ id: s.id, name: s.name, reason: s.verdicts[persona].reason })),
      worst_hazard: worst ? { type_id: worst.type_id, severity: worst.severity, note: worst.note, segment_name: worst.segment_name, label_en: scoring.TYPES[worst.type_id]?.label_en } : null,
    };
  });
  // recommended: highest score with at least 40% coverage; else most covered
  const eligible = routes.filter((r) => r.coverage >= 40 && r.score != null);
  const pool = eligible.length ? eligible : routes;
  const recommended = pool.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.coverage - a.coverage || a.distance_m - b.distance_m)[0];
  res.json({ ok: true, source, warning, persona, routes, recommended_index: recommended ? recommended.index : null });
});

// ---------- boot ----------
function seedIfEmpty() {
  if (!db.isEmpty()) return;
  try {
    const seed = require('./data/seed.json');
    for (const s of seed.segments) {
      const photos = s.photos.map((p) => ({ ...p, hazards: (p.hazards || []).map(scoring.enrichHazard).filter(Boolean), status: 'seed' }));
      const graded = scoring.gradeSegment({ name: s.name, start: s.start, end: s.end, source: 'walk' }, photos);
      db.saveSegment(graded, photos);
    }
    console.log(`[seed] loaded ${seed.segments.length} segments`);
  } catch (err) { console.warn('[seed] skipped:', err.message); }
}

app.use((err, _req, res, _next) => {
  console.error('[http]', err.message);
  if (err instanceof multer.MulterError) return fail(res, 400, `upload: ${err.message}`);
  fail(res, 500, 'server error');
});

if (require.main === module) {
  seedIfEmpty();
  app.listen(PORT, () => {
    console.log(`Rasta on http://localhost:${PORT}  model=${vision.MODEL}${vision.MOCK ? ' (MOCK vision — add ANTHROPIC_API_KEY to .env)' : ''}`);
  });
}
module.exports = { app, seedIfEmpty };
