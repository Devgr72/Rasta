// server.js — Express app, all routes. Static frontend from /public.
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const db = require('./db');
const scoring = require('./scoring');
const vision = require('./vision');
const { imageSize } = require('./lib/image-size');
const { createStorage } = require('./lib/storage');
const exif = require('./lib/exif');
const osrm = require('./lib/osrm');

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = process.env.RASTA_UPLOAD_DIR || path.join(__dirname, 'uploads');
const TILE_URL = process.env.RASTA_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = process.env.RASTA_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ROUTE_RADIUS_M = 40; // CLAUDE.md: graded segments within 40 m of a 25 m sample count
const ADMIN_TOKEN = process.env.RASTA_ADMIN_TOKEN || '';
const MAX_FILES = 12;
const MAX_FILE_MB = 8;
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.RASTA_MAX_UPLOAD_MB) || 40);   // all photos in one request
const MAX_IMAGE_PX = Math.max(256, Number(process.env.RASTA_MAX_IMAGE_PX) || 6000); // longest side, decoded

// Photo files: local disk by default, an S3-compatible bucket with RASTA_STORAGE=s3.
const storage = createStorage(process.env, { uploadDir: UPLOAD_DIR });
db.setUrlBuilder((f) => storage.url(f));

const app = express();
app.disable('x-powered-by');

// Behind a reverse proxy (Render, Fly, nginx) set RASTA_TRUST_PROXY to the number of hops so
// req.ip is the client, not the proxy. Never `true`: that lets anyone spoof X-Forwarded-For.
if (process.env.RASTA_TRUST_PROXY) app.set('trust proxy', Number(process.env.RASTA_TRUST_PROXY) || 1);

// Security headers. The CSP allows exactly the third parties the frontend uses: the tile host,
// Google Fonts on both pages, blob: previews of photos before upload, and data: for the favicon.
function hostPattern(urlTemplate) {
  try { return new URL(urlTemplate.replace(/\{s\}/g, 'x')).origin.replace('//x.', '//*.'); } catch { return null; }
}
const tileHost = hostPattern(TILE_URL);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // Leaflet and the app set inline style attributes
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:', ...(tileHost ? [tileHost] : []), 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'self'"],
      'upgrade-insecure-requests': null, // the local demo runs on plain http
    },
  },
  crossOriginEmbedderPolicy: false,          // tiles and fonts are cross-origin without CORP headers
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // let uploaded photos be embedded elsewhere (reports)
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Per-IP rate limits on the two endpoints that cost money or hit a third party. 0 disables.
const WINDOW_MIN = Math.max(1, Number(process.env.RASTA_RATE_LIMIT_WINDOW_MIN) || 15);
const limiter = (envName, fallback, what) => {
  const max = process.env[envName] === undefined ? fallback : Number(process.env[envName]);
  if (!max) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: WINDOW_MIN * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => fail(res, 429, `Too many ${what} from this address — try again in a few minutes`, { retry_after_min: WINDOW_MIN }),
  });
};
const segmentLimiter = limiter('RASTA_RATE_LIMIT_SEGMENTS', 30, 'footpath uploads');
const routeLimiter = limiter('RASTA_RATE_LIMIT_ROUTE', 120, 'route requests');

app.use(express.json({ limit: `${MAX_UPLOAD_MB}mb` }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
if (storage.kind === 'local') {
  app.use('/uploads', express.static(storage.dir, { maxAge: '7d', immutable: true }));
} else {
  // Same URL shape under S3 when no public bucket URL is configured: stream the object through.
  app.get('/uploads/:file', async (req, res) => {
    try {
      const obj = await storage.get(path.basename(req.params.file));
      if (!obj) return fail(res, 404, 'photo not found');
      res.set('Content-Type', obj.contentType);
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      if (obj.size) res.set('Content-Length', String(obj.size));
      const { Readable } = require('stream');
      (obj.body instanceof Readable ? obj.body : Readable.fromWeb(obj.body)).pipe(res);
    } catch (err) { console.error('[uploads] proxy failed', err.message); fail(res, 502, 'photo storage unavailable'); }
  });
}
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '30d', immutable: true }));
app.use('/vendor/exifr', express.static(path.join(__dirname, 'node_modules', 'exifr', 'dist'), { maxAge: '30d', immutable: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_FILES, fileSize: MAX_FILE_MB * 1024 * 1024 },
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

// Reject before any model call: too many bytes in one request, an unrecognised format, or an
// image so large that decoding it would be the attack. Returns an error string or null.
function checkPhotoBuffers(buffers) {
  if (buffers.length > MAX_FILES) return `at most ${MAX_FILES} photos per footpath`;
  const total = buffers.reduce((s, b) => s + b.length, 0);
  if (total > MAX_UPLOAD_MB * 1024 * 1024) return `photos total ${(total / 1048576).toFixed(1)} MB — the limit is ${MAX_UPLOAD_MB} MB per upload`;
  for (const [i, b] of buffers.entries()) {
    if (b.length > MAX_FILE_MB * 1024 * 1024) return `photo ${i + 1} is over ${MAX_FILE_MB} MB`;
    const dim = imageSize(b);
    if (!dim) return `photo ${i + 1} is not a JPEG, PNG, WebP or GIF`;
    if (dim.width > MAX_IMAGE_PX || dim.height > MAX_IMAGE_PX) return `photo ${i + 1} is ${dim.width}×${dim.height} px — resize to under ${MAX_IMAGE_PX} px a side`;
  }
  return null;
}

// Optional per-photo hints from the client (the browser strips EXIF when it resizes, so it reads
// GPS/time first and sends them alongside): photo_meta = [{lat, lng, taken_at}] aligned with photos.
function parsePhotoMeta(body, n) {
  let list = body.photo_meta;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = null; } }
  if (!Array.isArray(list)) return Array.from({ length: n }, () => ({}));
  return Array.from({ length: n }, (_, i) => {
    const m = list[i] || {};
    const p = parsePoint({ lat: m.lat, lng: m.lng });
    return { lat: p ? p.lat : null, lng: p ? p.lng : null, taken_at: normaliseTime(m.taken_at) };
  });
}
// Keep an ISO-ish wall-clock string as given (EXIF has no zone); coerce anything else through Date.
function normaliseTime(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(s)) return s.slice(0, 32);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function analyseAndSave({ name, start, end }, buffers, onPhoto, hints = []) {
  const snapPromise = osrm.snapToFootway(start, end).catch((err) => {
    console.warn('[snap] failed', err.message);
    return { geometry: { type: 'LineString', coordinates: [[start.lng, start.lat], [end.lng, end.lat]] }, length_m: null, source: 'straight', snapped: false };
  });
  // all photos in parallel — one API call each
  const results = await Promise.all(buffers.map(async (buf, i) => {
    // Read GPS / capture time / orientation, then keep only the pixels (plus orientation).
    const { meta: xf, buf: clean, stripped_bytes } = await exif.readAndStrip(buf);
    const hint = hints[i] || {};
    let r;
    try {
      r = await vision.analysePhoto(buf); // hash of the original bytes keys the cache
    } catch (err) {
      console.error('[vision] unexpected throw', err);
      r = { ...vision.validate({ hazards: [] }), meta: { hash: vision.sha256(buf), error: err.message } };
    }
    const filename = `${r.meta.hash.slice(0, 16)}.${extFor(buf)}`;
    try { await storage.put(filename, clean, `image/${extFor(buf) === 'jpg' ? 'jpeg' : extFor(buf)}`); }
    catch (err) { console.warn('[upload] store failed', err.message); }
    if (stripped_bytes > 0) console.log(`[upload] ${filename} stripped ${stripped_bytes} bytes of metadata${xf.lat != null ? ' (GPS kept in DB)' : ''}`);
    const photo = {
      index: i,
      filename,
      url: storage.url(filename),
      hash: r.meta.hash,
      hazards: r.hazards.map(scoring.enrichHazard).filter(Boolean),
      estimated_clear_width_m: r.estimated_clear_width_m,
      surface_type: r.surface_type,
      observations: r.observations,
      status: r.meta.error ? 'failed' : r.meta.mock ? 'mock' : 'ok',
      error: r.meta.error || null,
      latency_ms: r.meta.latency_ms,
      cached: !!r.meta.cached,
      photo_lat: xf.lat ?? hint.lat ?? null,
      photo_lng: xf.lng ?? hint.lng ?? null,
      taken_at: xf.taken_at || hint.taken_at || null,
    };
    if (onPhoto) onPhoto(photo);
    return photo;
  }));

  const graded = scoring.gradeSegment({ name, start, end }, results);
  // Snap the clicked points to the footway so the map and route scoring follow the real path.
  // Runs alongside the photo analysis; on any failure the straight line is stored (never blocks).
  const snap = await snapPromise;
  graded.geometry = snap.geometry;
  if (snap.snapped) graded.length_m = snap.length_m;
  const id = db.saveSegment(graded, results.map((p) => ({ ...p, hazards: p.hazards })));
  return { ...db.getSegment(id), cost_by_authority: graded.cost_by_authority, photo_results: results, geometry_source: snap.source };
}

// ---------- API ----------
app.get('/api/health', (_req, res) => {
  let budget_reached = false;
  try { budget_reached = vision.usage().budget_reached; } catch { /* stats are best-effort */ }
  res.json({ ok: true, model: vision.MODEL, mock: vision.MOCK, concurrency: vision.CONCURRENCY, daily_token_budget: vision.DAILY_BUDGET || null, budget_reached, storage: storage.kind, schema_version: db.MIGRATIONS.length });
});

app.get('/api/standards', (_req, res) => res.json(scoring.STANDARDS));

// Public, non-secret configuration the frontend needs (tile host, limits). Never the API key.
app.get('/api/config', (_req, res) => res.json({
  tile_url: TILE_URL,
  tile_attribution: TILE_ATTRIBUTION,
  routing: osrm.OSRM_BASE.includes('router.project-osrm.org') ? 'public-demo' : 'configured',
  max_photos: MAX_FILES,
  max_image_px: MAX_IMAGE_PX,
  max_upload_mb: MAX_UPLOAD_MB,
  model: vision.MODEL,
  mock: vision.MOCK,
}));

app.get('/api/stats', (_req, res) => {
  try { res.json({ ...db.stats(), vision: vision.usage() }); } catch (err) { fail(res, 500, err.message); }
});

// Takedowns. Needs RASTA_ADMIN_TOKEN configured and sent as `Authorization: Bearer <token>`.
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return fail(res, 404, 'not found'); // admin routes do not exist without a token
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const given = Buffer.from(m ? m[1].trim() : '');
  const want = Buffer.from(ADMIN_TOKEN);
  if (given.length !== want.length || !require('crypto').timingSafeEqual(given, want)) return fail(res, 401, 'unauthorised');
  next();
}
app.delete('/api/segments/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'bad id');
  try {
    const r = db.deleteSegment(id);
    if (!r) return fail(res, 404, 'segment not found');
    let files_removed = 0;
    for (const f of r.orphaned_files) {
      try { if (await storage.delete(f)) files_removed++; } catch (err) { console.warn('[admin] file delete failed', err.message); }
    }
    console.log(`[admin] deleted segment #${id}, removed ${files_removed} orphaned photo file(s)`);
    res.json({ ok: true, id, files_removed });
  } catch (err) { fail(res, 500, err.message); }
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
app.post('/api/segments', segmentLimiter, upload.array('photos', MAX_FILES), async (req, res) => {
  const body = req.body || {};
  const point = (v, lat, lng) => { try { return parsePoint(v ? (typeof v === 'string' ? JSON.parse(v) : v) : { lat, lng }); } catch { return null; } };
  const start = point(body.start, body.start_lat, body.start_lng);
  const end = point(body.end, body.end_lat, body.end_lng);
  const name = String(body.name || '').trim().slice(0, 120) || 'Unnamed footpath';
  if (!start || !end) return fail(res, 400, 'start and end must be {lat,lng}');
  const buffers = collectPhotoBuffers(req);
  if (!buffers.length) return fail(res, 400, 'attach at least one photo');
  const bad = checkPhotoBuffers(buffers);
  if (bad) return fail(res, 400, bad);

  const stream = req.query.stream === '1';
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write(JSON.stringify({ type: 'start', photos: buffers.length, model: vision.MODEL, mock: vision.MOCK }) + '\n');
  }
  try {
    const hints = parsePhotoMeta(body, buffers.length);
    const segment = await analyseAndSave({ name, start, end }, buffers, stream ? (p) => res.write(JSON.stringify({ type: 'photo', photo: p }) + '\n') : null, hints);
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

app.post('/api/route', routeLimiter, async (req, res) => {
  const from = parsePoint(req.body?.from), to = parsePoint(req.body?.to);
  const persona = ['walk', 'wheelchair', 'senior'].includes(req.body?.persona) ? req.body.persona : 'walk';
  if (!from || !to) return fail(res, 400, 'from and to must be {lat,lng}');
  let result, source, warning = null;
  try {
    ({ json: result, source } = await osrm.fetchAlternatives(from, to));
  } catch (err) {
    console.warn('[route] OSRM failed, using cached demo route:', err.message);
    if (!demoRoute) return fail(res, 502, 'routing service unavailable and no cached route');
    result = demoRoute; source = 'cached'; warning = 'Live routing unavailable, showing the cached demo route';
  }
  // Spatial pre-filter: only segments whose bbox touches the routes' bbox (padded by the match
  // radius) are loaded, so scoring stays fast at ten thousand segments.
  const allCoords = result.routes.flatMap((r) => r.geometry.coordinates);
  const segments = db.segmentsInBbox(scoring.padBbox(scoring.bboxOf(allCoords), ROUTE_RADIUS_M));
  const routes = result.routes.map((r, i) => {
    const scored = scoring.scoreRoute(r.geometry.coordinates, segments, { radiusM: ROUTE_RADIUS_M });
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
  res.json({ ok: true, source, warning, persona, routes, recommended_index: recommended ? recommended.index : null, candidates: segments.length });
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
  if (err.type === 'entity.too.large') return fail(res, 413, `request body over ${MAX_UPLOAD_MB} MB`);
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'malformed JSON body');
  fail(res, 500, 'server error');
});

function start(port = PORT) {
  seedIfEmpty();
  return app.listen(port, () => {
    console.log(`Rasta on http://localhost:${port}  model=${vision.MODEL}${vision.MOCK ? ' (MOCK vision — add ANTHROPIC_API_KEY to .env)' : ''}`);
  });
}

if (require.main === module) start();
module.exports = { app, seedIfEmpty, start };
