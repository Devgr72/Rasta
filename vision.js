// vision.js — the only file that touches the Anthropic API key.
// One photo in, one validated hazard JSON out. Cached by photo hash.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const STANDARDS = require('./knowledge/standards.json');
const MODEL = process.env.RASTA_MODEL || 'claude-fable-5-1';
const CACHE_DIR = path.join(__dirname, 'data', 'vision-cache');
const HAZARD_IDS = new Set(STANDARDS.hazard_types.map((h) => h.id));
const SURFACES = new Set(['paver', 'concrete', 'none', 'mud', 'asphalt', 'stone']);
const MOCK = process.env.RASTA_MOCK_VISION === '1' || !process.env.ANTHROPIC_API_KEY;

let client = null;
function getClient() {
  if (!client) {
    // Org-level keys must name a workspace; workspace-scoped keys can leave this unset.
    const defaultHeaders = process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {};
    client = new Anthropic({ timeout: 90_000, maxRetries: 1, defaultHeaders });
  }
  return client;
}

// The knowledge file is injected verbatim so the model audits against the
// same ids, thresholds and authorities the rest of the app uses.
const SYSTEM_PROMPT = `You are a footpath accessibility auditor working in Indian cities. You look at one photograph of a footpath and record every hazard a wheelchair user, a senior citizen or a blind pedestrian would meet on it, against the standards below.

Return strict JSON only. No prose, no markdown fences, no comments. Shape:
{
  "surface_type": "paver | concrete | asphalt | stone | mud | none",
  "hazards": [
    { "type_id": "<one of the hazard_types ids below>", "severity": 1-5, "bbox": {"x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1}, "note": "one short factual line with an estimated dimension where possible" }
  ],
  "estimated_clear_width_m": <number or null if the path itself is not visible>,
  "observations": "one or two sentences on what the path is like to walk"
}

Rules:
- bbox is normalised to the image: x,y is the top-left corner, w,h the size, all between 0 and 1. Draw it tightly around the hazard you are describing.
- Only use type_id values from the knowledge below. If nothing matches, leave it out.
- One hazard per distinct physical problem. Repeating tiles broken along a stretch is one hazard with one bbox that covers the stretch.
- Severity: 1 cosmetic, 2 slows people down, 3 forces a detour or careful step, 4 likely fall or blocked wheelchair, 5 injury risk or impassable.
- Estimate clear width as the usable width between obstructions, not the built width.
- A footpath with nothing wrong returns an empty hazards array. Do not invent hazards.

KNOWLEDGE:
${JSON.stringify(STANDARDS)}`;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function detectMediaType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}

function stripFences(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < t.length - 1)) t = t.slice(first, last + 1);
  return t.trim();
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Coerce the model output into the contract. Anything malformed is dropped,
// never thrown — a bad box should not sink a whole segment.
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not an object');
  if (!Array.isArray(raw.hazards)) throw new Error('hazards is not an array');
  const hazards = [];
  for (const h of raw.hazards) {
    if (!h || !HAZARD_IDS.has(h.type_id)) continue;
    const b = h.bbox || {};
    const x = clamp(Number(b.x) || 0, 0, 1);
    const y = clamp(Number(b.y) || 0, 0, 1);
    const w = clamp(Number(b.w) || 0.05, 0.01, 1 - x);
    const hh = clamp(Number(b.h) || 0.05, 0.01, 1 - y);
    hazards.push({
      type_id: h.type_id,
      severity: clamp(Math.round(Number(h.severity) || 3), 1, 5),
      bbox: { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +hh.toFixed(4) },
      note: String(h.note || '').slice(0, 200),
    });
  }
  const width = raw.estimated_clear_width_m;
  return {
    surface_type: SURFACES.has(raw.surface_type) ? raw.surface_type : 'none',
    hazards,
    estimated_clear_width_m: width == null || Number.isNaN(Number(width)) ? null : clamp(Number(width), 0, 10),
    observations: String(raw.observations || '').slice(0, 400),
  };
}

function readCache(hash) {
  try {
    const p = path.join(CACHE_DIR, `${hash}.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn('[vision] cache read failed', err.message);
  }
  return null;
}

function writeCache(hash, result) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${hash}.json`), JSON.stringify(result, null, 2));
  } catch (err) {
    console.warn('[vision] cache write failed', err.message);
  }
}

async function callModel(imageB64, mediaType, repairHint) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
    { type: 'text', text: repairHint
      ? `Your previous answer was not valid JSON (${repairHint}). Return the audit again as a single strict JSON object and nothing else.`
      : 'Audit this footpath photograph. Return the JSON object only.' },
  ];
  const res = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') {
    const why = res.stop_details?.explanation || res.stop_details?.category || 'refused';
    throw Object.assign(new Error(`model declined: ${why}`), { refusal: true });
  }
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// Deterministic stand-in used when no key is configured, so the UI and the
// scoring pipeline can be exercised end to end. Clearly flagged as mock.
function mockResult(hash) {
  const ids = [...HAZARD_IDS];
  const n = (parseInt(hash.slice(0, 2), 16) % 3) + 1;
  const hazards = [];
  for (let i = 0; i < n; i++) {
    const seed = parseInt(hash.slice(2 + i * 4, 6 + i * 4), 16);
    const t = ids[seed % ids.length];
    hazards.push({
      type_id: t,
      severity: (seed % 4) + 2,
      bbox: { x: +((seed % 50) / 100).toFixed(2), y: +(0.35 + ((seed >> 3) % 40) / 100).toFixed(2), w: 0.28, h: 0.22 },
      note: 'Mock observation — set ANTHROPIC_API_KEY in .env for real analysis',
    });
  }
  return validate({ surface_type: 'paver', hazards, estimated_clear_width_m: 1.1 + (n % 3) * 0.4, observations: 'Mock analysis. No model was called.' });
}

/**
 * Analyse one photo. Accepts a file path or a Buffer.
 * Resolves to { ...contract, meta: { hash, cached, latency_ms, model, mock, error? } }.
 * Never throws for model or parse problems — returns zero hazards with meta.error set.
 */
async function analysePhoto(input) {
  const t0 = Date.now();
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const hash = sha256(buf);
  const label = Buffer.isBuffer(input) ? hash.slice(0, 8) : path.basename(input);

  const cached = readCache(hash);
  if (cached) {
    console.log(`[vision] ${label} cache hit (${Date.now() - t0}ms)`);
    return { ...cached, meta: { ...cached.meta, cached: true, latency_ms: Date.now() - t0 } };
  }

  if (MOCK) {
    const result = { ...mockResult(hash), meta: { hash, cached: false, latency_ms: 0, model: 'mock', mock: true } };
    console.log(`[vision] ${label} MOCK (no ANTHROPIC_API_KEY)`);
    return result;
  }

  if (buf.length > 4.8 * 1024 * 1024) {
    return { ...validate({ hazards: [] }), meta: { hash, cached: false, latency_ms: 0, model: MODEL, mock: false, error: 'photo over 4.8 MB — resize before upload' } };
  }

  const b64 = buf.toString('base64');
  const mediaType = detectMediaType(buf);
  let lastErr = null;
  let repairHint = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await callModel(b64, mediaType, repairHint);
      const parsed = JSON.parse(stripFences(text));
      const result = { ...validate(parsed), meta: { hash, cached: false, latency_ms: Date.now() - t0, model: MODEL, mock: false, attempts: attempt } };
      console.log(`[vision] ${label} ${result.hazards.length} hazards in ${result.meta.latency_ms}ms (attempt ${attempt})`);
      writeCache(hash, result);
      return result;
    } catch (err) {
      lastErr = err;
      const isParse = err instanceof SyntaxError || /not an object|not an array/.test(err.message);
      console.warn(`[vision] ${label} attempt ${attempt} failed: ${err.message}`);
      if (err.refusal || !isParse) break; // network / API errors are not fixed by a repair prompt
      repairHint = err.message.slice(0, 120);
    }
  }
  return {
    ...validate({ hazards: [] }),
    meta: { hash, cached: false, latency_ms: Date.now() - t0, model: MODEL, mock: false, error: lastErr ? lastErr.message : 'unknown failure' },
  };
}

module.exports = { analysePhoto, validate, stripFences, sha256, MODEL, MOCK };
