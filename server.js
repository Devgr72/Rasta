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

// ---------- routing ----------
let demoRoute = null;
try { demoRoute = require('./data/demo-route.json'); } catch { console.warn('[route] no data/demo-route.json'); }

async function fetchOSRM(from, to) {
  const url = `${OSRM_BASE}/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?alternatives=3&overview=full&geometries=geojson&steps=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'rasta-footpath-map/0.1' } });
    if (!r.ok) throw new Error(`OSRM ${r.status}`);
    const json = await r.json();
    if (json.code !== 'Ok' || !json.routes?.length) throw new Error(`OSRM ${json.code || 'no routes'}`);
    return { json, source: 'osrm' };
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
      const graded = scoring.gradeSegment({ name: s.name, start: s.start, end: s.end }, photos);
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
