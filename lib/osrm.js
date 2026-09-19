// lib/osrm.js — every call to the routing server, with a hard timeout and a non-fatal fallback.
//   snapToFootway(start, end)  → the footway polyline between two clicked points (match → route → straight line)
//   fetchAlternatives(from, to) → route alternatives for A→B comparison (foot + driving profiles, de-duplicated)
// The public demo server (router.project-osrm.org) is fine for development only — see README → Routing.
const scoring = require('../scoring');

const OSRM_BASE = (process.env.OSRM_BASE || 'https://router.project-osrm.org').replace(/\/$/, '');
const TIMEOUT_MS = Math.max(500, Number(process.env.OSRM_TIMEOUT_MS) || 3000);
const UA = 'rasta-footpath-map/0.2 (+https://github.com/Devgr72/Rasta)';

const coord = (p) => `${p.lng},${p.lat}`;
const straight = (start, end) => ({ type: 'LineString', coordinates: [[start.lng, start.lat], [end.lng, end.lat]] });

async function getJson(url, signal) {
  const r = await fetch(url, { signal, headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`OSRM ${r.status}`);
  return r.json();
}

/**
 * Snap two clicked points to the footway network. Tries the match service (map-matching the two
 * points onto ways), then the foot route between them, and falls back to the straight line.
 * A snapped result is rejected when it wanders: over 3× the straight-line distance (+100 m), or
 * with either end more than 150 m from where the user clicked.
 * Never throws. Resolves { geometry, length_m, source: 'osrm-match' | 'osrm-route' | 'straight', snapped }.
 */
async function snapToFootway(start, end, { base = OSRM_BASE, timeoutMs = TIMEOUT_MS } = {}) {
  const direct = straight(start, end);
  const directLen = scoring.polylineLength(direct.coordinates);
  const fallback = { geometry: direct, length_m: Math.round(directLen), source: 'straight', snapped: false };
  if (directLen < 5) return fallback;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const plausible = (coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return false;
    const len = scoring.polylineLength(coords);
    if (len > directLen * 3 + 100) return false;
    const a = coords[0], b = coords[coords.length - 1];
    const dA = scoring.haversine(start, { lng: a[0], lat: a[1] }), dB = scoring.haversine(end, { lng: b[0], lat: b[1] });
    return dA <= 150 && dB <= 150;
  };
  try {
    try {
      const m = await getJson(`${base}/match/v1/foot/${coord(start)};${coord(end)}?geometries=geojson&overview=full&steps=false&radiuses=50;50&tidy=true`, ctrl.signal);
      const g = m.code === 'Ok' && m.matchings && m.matchings[0] && m.matchings[0].geometry;
      if (g && plausible(g.coordinates)) return { geometry: g, length_m: Math.round(scoring.polylineLength(g.coordinates)), source: 'osrm-match', snapped: true };
    } catch (err) { if (err.name === 'AbortError') throw err; /* try route */ }
    const r = await getJson(`${base}/route/v1/foot/${coord(start)};${coord(end)}?geometries=geojson&overview=full&steps=false`, ctrl.signal);
    const g = r.code === 'Ok' && r.routes && r.routes[0] && r.routes[0].geometry;
    if (g && plausible(g.coordinates)) return { geometry: g, length_m: Math.round(scoring.polylineLength(g.coordinates)), source: 'osrm-route', snapped: true };
    return fallback;
  } catch (err) {
    console.warn('[snap] OSRM unavailable, storing the straight line:', err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message);
    return fallback;
  } finally { clearTimeout(timer); }
}

async function fetchProfile(base, profile, from, to, signal) {
  const json = await getJson(`${base}/route/v1/${profile}/${coord(from)};${coord(to)}?alternatives=3&overview=full&geometries=geojson&steps=false`, signal);
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(`OSRM ${profile} ${json.code || 'no routes'}`);
  return json.routes;
}

/**
 * Route alternatives A→B. The public foot profile almost never returns alternatives, so the
 * driving profile is asked too and any route whose length differs by over 4% is kept.
 * Throws when nothing came back — the caller decides on the cached fallback.
 */
async function fetchAlternatives(from, to, { base = OSRM_BASE, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const settled = await Promise.allSettled(['foot', 'driving'].map((p) => fetchProfile(base, p, from, to, ctrl.signal)));
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

module.exports = { snapToFootway, fetchAlternatives, OSRM_BASE, TIMEOUT_MS };
