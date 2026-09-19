// lib/geocode.js — place-name search and reverse lookup through a Nominatim-compatible server.
// Default is OpenStreetMap's public Nominatim, which allows at most one request per second and no
// keystroke autocomplete: requests are queued to that rate and answers cached for an hour. Point
// RASTA_GEOCODER_URL at your own instance (or Photon/LocationIQ with the same API) for production.
const BASE = (process.env.RASTA_GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const COUNTRY = process.env.RASTA_GEOCODER_COUNTRY || 'in';
const UA = 'rasta-footpath-map/0.2 (+https://github.com/Devgr72/Rasta)';
const MIN_GAP_MS = /nominatim\.openstreetmap\.org/.test(BASE) ? 1100 : 0;
const TTL_MS = 60 * 60 * 1000;

const cache = new Map();
let chain = Promise.resolve();
let lastAt = 0;

function cached(key) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - TTL_MS) return hit.value;
  if (hit) cache.delete(key);
  return null;
}
function remember(key, value) {
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

// One upstream call at a time, at least MIN_GAP_MS apart.
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function getJson(url, timeoutMs = 8000, lang = 'en') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': lang === 'hi' ? 'hi,en;q=0.8' : 'en' } });
    if (!r.ok) throw new Error(`geocoder ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const shortName = (r) => {
  const a = r.address || {};
  const first = r.name || a.amenity || a.building || a.road || a.neighbourhood || a.suburb || (r.display_name || '').split(',')[0];
  const area = a.suburb || a.neighbourhood || a.city_district || a.city || a.town || a.village || a.state_district || '';
  return area && area !== first ? `${first}, ${area}` : first;
};

/**
 * Search places. `near` ({lat,lng}) biases results to a ~20 km box around the map.
 * Resolves [{ name, display_name, lat, lng, type, importance }] (up to `limit`).
 */
async function search(q, { near, limit = 6, lang = 'en' } = {}) {
  const query = String(q || '').trim().slice(0, 200);
  if (query.length < 2) return [];
  lang = lang === 'hi' ? 'hi' : 'en';
  const key = `s:${lang}:${query.toLowerCase()}:${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}:${limit}`;
  const hit = cached(key);
  if (hit) return hit;
  const p = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: String(Math.min(10, limit)), dedupe: '1' });
  if (COUNTRY) p.set('countrycodes', COUNTRY);
  if (near) { const d = 0.18; p.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`); }
  const rows = await throttled(() => getJson(`${BASE}/search?${p}`, 8000, lang));
  const out = (Array.isArray(rows) ? rows : []).map((r) => ({
    name: shortName(r), display_name: r.display_name, lat: Number(r.lat), lng: Number(r.lon),
    type: r.type || r.category || '', importance: r.importance || 0,
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  return remember(key, out);
}

/** Nearest named place for a point, for labelling a map tap. Resolves { name, display_name } or null. */
async function reverse(lat, lng, { lang = 'en' } = {}) {
  lang = lang === 'hi' ? 'hi' : 'en';
  const key = `r:${lang}:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cached(key);
  if (hit) return hit;
  const p = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1', zoom: '17' });
  const r = await throttled(() => getJson(`${BASE}/reverse?${p}`, 8000, lang));
  if (!r || r.error) return remember(key, null);
  return remember(key, { name: shortName(r), display_name: r.display_name });
}

module.exports = { search, reverse, BASE, _cache: cache };
