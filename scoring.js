// scoring.js — segment score, persona verdicts, cost estimate, route scoring.
// Pure functions. No IO.
const STANDARDS = require('./knowledge/standards.json');
const TYPES = Object.fromEntries(STANDARDS.hazard_types.map((h) => [h.id, h]));

const EARTH_R = 6371000;
function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

// Indicative quantity from the box footprint. A phone photo of a footpath
// covers roughly 12 m² of ground and 8 m of run — good enough for scoping.
function estimateQuantity(type, bbox) {
  const b = bbox || { w: 0.3, h: 0.2 };
  switch (type.unit) {
    case 'sqm': return Math.max(1, Math.round(b.w * b.h * 12));
    case 'm': return Math.max(1, Math.round(b.w * 8));
    case 'each': return 1;
    default: return 0;
  }
}

/** Enrich a raw vision hazard with label, cost and authority from the knowledge file. */
function enrichHazard(h) {
  const type = TYPES[h.type_id];
  if (!type) return null;
  const qty = estimateQuantity(type, h.bbox);
  return {
    ...h,
    label_en: type.label_en,
    label_hi: type.label_hi,
    authority: type.authority,
    standard_ref: type.standard_ref,
    cost_inr: Math.round(type.cost_per_unit_inr * qty),
    quantity: qty,
    unit: type.unit,
    risk: { walk: type.base_severity, senior: type.senior_risk, wheelchair: type.wheelchair_risk },
  };
}

function scoreFromHazards(hazards, clearWidth) {
  let deduction = 0;
  for (const h of hazards) deduction += h.severity * 6;
  deduction = Math.min(85, deduction);
  let score = 100 - deduction;
  if (clearWidth != null) {
    if (clearWidth < 0.9) score -= 25;
    else if (clearWidth < 1.2) score -= 15;
  }
  return Math.max(5, Math.round(score));
}

function worstBy(hazards, key) {
  let worst = null;
  for (const h of hazards) {
    if (!worst || h.risk[key] > worst.risk[key] || (h.risk[key] === worst.risk[key] && h.severity > worst.severity)) worst = h;
  }
  return worst;
}

function personaVerdicts(hazards, clearWidth) {
  const verdict = (key) => {
    const worst = worstBy(hazards, key);
    if (worst && worst.risk[key] >= 4) {
      return { ok: false, reason: `Blocked by ${worst.label_en.toLowerCase()}${worst.note ? ` — ${worst.note}` : ''}`, hazard_id: worst.type_id };
    }
    return null;
  };

  const walk = verdict('walk') || { ok: true, reason: hazards.length ? 'Passable on foot with care' : 'Clear footpath' };
  const senior = verdict('senior') || { ok: true, reason: hazards.length ? 'Passable for seniors, uneven in places' : 'Level and clear for seniors' };

  let wheelchair = verdict('wheelchair');
  if (!wheelchair && hazards.some((h) => h.type_id === 'no_kerb_ramp')) {
    wheelchair = { ok: false, reason: 'Blocked: no kerb ramp — a wheelchair cannot get on or off the footpath', hazard_id: 'no_kerb_ramp' };
  }
  if (!wheelchair && clearWidth != null && clearWidth < 1.2) {
    wheelchair = { ok: false, reason: `Blocked: clear width ${clearWidth.toFixed(1)} m is under the 1.2 m a wheelchair needs`, hazard_id: 'narrow_path' };
  }
  if (!wheelchair) wheelchair = { ok: true, reason: clearWidth != null ? `Rollable, ${clearWidth.toFixed(1)} m clear` : 'Rollable, no blocking hazards seen' };

  return { walk, senior, wheelchair };
}

/**
 * Combine per-photo vision results into one graded segment.
 * photos: [{ hazards, estimated_clear_width_m, surface_type, ... }]
 */
function gradeSegment({ name, start, end, geometry, source, osm_id, tags }, photoResults) {
  // geometry may arrive as GeoJSON ({type, coordinates}) or a raw [[lng,lat],...] list (OSM import)
  const rawCoords = Array.isArray(geometry) ? geometry : geometry && Array.isArray(geometry.coordinates) ? geometry.coordinates : null;
  const coords = rawCoords && rawCoords.length > 1 ? rawCoords : null;
  const hazards = [];
  const photos = photoResults.map((r) => {
    const enriched = (r.hazards || []).map(enrichHazard).filter(Boolean);
    hazards.push(...enriched);
    return { ...r, hazards: enriched };
  });
  const widths = photos.map((p) => p.estimated_clear_width_m).filter((w) => w != null);
  const clearWidth = widths.length ? Math.min(...widths) : null;
  const surfaces = photos.map((p) => p.surface_type).filter((s) => s && s !== 'none');
  const surface = surfaces.sort((a, b) => surfaces.filter((v) => v === b).length - surfaces.filter((v) => v === a).length)[0] || 'none';

  const score = scoreFromHazards(hazards, clearWidth);
  const verdicts = personaVerdicts(hazards, clearWidth);
  const total_cost_inr = hazards.reduce((s, h) => s + h.cost_inr, 0);
  const authorities = {};
  for (const h of hazards) authorities[h.authority] = (authorities[h.authority] || 0) + h.cost_inr;

  return {
    name,
    start,
    end,
    length_m: Math.round(coords ? polylineLength(coords) : haversine(start, end)),
    geometry: coords ? { type: 'LineString', coordinates: coords } : null,
    source: source || 'walk',
    osm_id: osm_id || null,
    tags: tags || null,
    score,
    clear_width_m: clearWidth,
    surface_type: surface,
    verdicts,
    total_cost_inr,
    cost_by_authority: authorities,
    hazards,
    photos,
  };
}

// ---------- geometry helpers (coords are GeoJSON [lng, lat]) ----------
const M_PER_DEG_LAT = 110540;
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Length of a polyline in metres. */
function polylineLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine({ lng: coords[i - 1][0], lat: coords[i - 1][1] }, { lng: coords[i][0], lat: coords[i][1] });
  return m;
}

/** Bounding box {min_lat, min_lng, max_lat, max_lng} of a coordinate list. */
function bboxOf(coords) {
  const b = { min_lat: Infinity, min_lng: Infinity, max_lat: -Infinity, max_lng: -Infinity };
  for (const [lng, lat] of coords) {
    if (lat < b.min_lat) b.min_lat = lat; if (lat > b.max_lat) b.max_lat = lat;
    if (lng < b.min_lng) b.min_lng = lng; if (lng > b.max_lng) b.max_lng = lng;
  }
  return b;
}

/** Grow a bbox by `metres` on every side. */
function padBbox(b, metres) {
  const dLat = metres / M_PER_DEG_LAT;
  const dLng = metres / mPerDegLng((b.min_lat + b.max_lat) / 2);
  return { min_lat: b.min_lat - dLat, max_lat: b.max_lat + dLat, min_lng: b.min_lng - dLng, max_lng: b.max_lng + dLng };
}

/**
 * Shortest distance in metres from a point {lat,lng} to a polyline, using a local flat
 * projection (exact enough for tens of metres at city scale, and far cheaper than haversine per vertex).
 */
function pointToPolylineM(p, coords) {
  if (!coords || !coords.length) return Infinity;
  const kx = mPerDegLng(p.lat), ky = M_PER_DEG_LAT;
  let best = Infinity;
  let ax = (coords[0][0] - p.lng) * kx, ay = (coords[0][1] - p.lat) * ky;
  if (coords.length === 1) return Math.hypot(ax, ay);
  for (let i = 1; i < coords.length; i++) {
    const bx = (coords[i][0] - p.lng) * kx, by = (coords[i][1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0; // projection of the origin (the point) onto the segment
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best) best = d;
    ax = bx; ay = by;
  }
  return best;
}

/** The polyline a segment is scored against: stored footway geometry, else the straight line. */
function segmentCoords(s) {
  const g = s.geometry && s.geometry.coordinates;
  if (Array.isArray(g) && g.length >= 2) return g;
  return [[s.start.lng, s.start.lat], [s.end.lng, s.end.lat]];
}

/**
 * Score a route polyline against graded segments. coords: [[lng,lat],...]
 * Samples the route every `sampleEveryM`; a sample is covered when it lies within `radiusM` of a
 * segment's polyline (point-to-polyline distance, not midpoint). Covered samples contribute each
 * matched segment's score weighted by its length. Coverage is the share of samples that found data.
 * Pure: no IO. Callers may pre-filter `segments` by bounding box; results are identical.
 */
/** Metres from a point to a polyline given as [{lat,lng}] */
function distanceToLine(p, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    // project in a local flat frame (fine at street scale)
    const kx = Math.cos((a.lat * Math.PI) / 180);
    const ax = a.lng * kx, ay = a.lat, bx = b.lng * kx, by = b.lat, px = p.lng * kx, py = p.lat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const q = { lat: ay + dy * t, lng: (ax + dx * t) / kx };
    best = Math.min(best, haversine(p, q));
  }
  return pts.length === 1 ? haversine(p, pts[0]) : best;
}

const BAD_SURFACES = new Set(['unpaved', 'ground', 'dirt', 'earth', 'mud', 'sand', 'gravel', 'fine_gravel', 'grass', 'compacted', 'pebblestone', 'rock']);
const ROADS = new Set(['residential', 'tertiary', 'secondary', 'primary', 'unclassified', 'trunk', 'living_street', 'tertiary_link', 'secondary_link', 'primary_link']);

function parseIncline(v) {
  if (!v) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(v.trim());
  if (m) return Math.abs(Number(m[1]));
  const r = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(v.trim());
  if (r) return 100 / Number(r[1]);
  return null;
}
function parseWidth(v) {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(m|metre|meter)?s?$/i.exec(v.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Turn OpenStreetMap way tags into the same observation shape a photo yields,
 * so tag-derived footpaths are graded by exactly the same rules. Returns null
 * when the tags say nothing about accessibility.
 */
function tagsToObservation(tags = {}) {
  const hazards = [];
  const notes = [];
  const add = (type_id, severity, note) => hazards.push({ type_id, severity, bbox: null, note: `${note} (OpenStreetMap)` });
  const hw = tags.highway;
  let relevant = false;

  if (hw === 'steps' && !/ramp/.test(tags.ramp || '') && tags['ramp:wheelchair'] !== 'yes') { add('steps_on_path', 4, `${tags.step_count ? tags.step_count + ' steps' : 'Steps'} with no ramp`); relevant = true; }
  if (tags.wheelchair === 'no') { relevant = true; if (hw !== 'steps') add('steps_on_path', 3, 'Tagged not usable by wheelchair, usually steps or kerbs at the ends'); }
  if (tags.wheelchair === 'limited') { relevant = true; add('uneven_level', 2, 'Tagged limited wheelchair access'); }
  if (tags.wheelchair === 'yes') { relevant = true; notes.push('tagged wheelchair accessible'); }

  const sm = tags.smoothness;
  if (sm) {
    relevant = true;
    const sev = { intermediate: 1, bad: 3, very_bad: 4, horrible: 5, very_horrible: 5, impassable: 5 }[sm];
    if (sev) add('uneven_level', sev, `Surface smoothness tagged "${sm.replace('_', ' ')}"`); else notes.push(`smoothness ${sm}`);
  }
  if (tags.surface) {
    if (BAD_SURFACES.has(tags.surface)) { relevant = true; if (!hazards.some((h) => h.type_id === 'uneven_level')) add('uneven_level', tags.surface === 'mud' ? 4 : 3, `Unpaved surface (${tags.surface})`); }
    else notes.push(`surface ${tags.surface}`); // a good surface alone is not evidence enough to grade a footpath
  }
  if (tags.kerb === 'raised') { relevant = true; add('high_kerb', 3, 'Raised kerb without a ramp'); }
  if (tags.kerb === 'lowered' || tags.kerb === 'flush') { relevant = true; notes.push(`kerb ${tags.kerb}`); }
  if (tags.tactile_paving === 'no') { relevant = true; add('missing_tactile', 2, 'No tactile paving'); }
  if (tags.tactile_paving === 'yes') { relevant = true; notes.push('tactile paving present'); }
  if (tags.lit === 'no') { relevant = true; add('missing_streetlight', 2, 'Not lit at night'); }
  const width = parseWidth(tags.width);
  if (width != null) { relevant = true; if (width < 1.2) add('narrow_path', 3, `Tagged width ${width} m`); else if (width < 1.8) add('narrow_path', 2, `Tagged width ${width} m, under the 1.8 m standard`); else notes.push(`width ${width} m`); }
  const inc = parseIncline(tags.incline);
  if (inc != null) { relevant = true; if (inc > 12) add('steep_ramp', 4, `Incline ${tags.incline}, steeper than 1:8`); else if (inc > 8.4) add('steep_ramp', 3, `Incline ${tags.incline}, steeper than 1:12`); }
  if (ROADS.has(hw) && /^(no|none)$/.test(tags.sidewalk || '')) { relevant = true; add('no_footpath', /^(primary|secondary|trunk)$/.test(hw) ? 4 : 3, `Road mapped with no footpath (${hw.replace('_', ' ')})`); }
  if (ROADS.has(hw) && /^(both|left|right|separate)$/.test(tags.sidewalk || '')) { relevant = true; notes.push(`footpath on ${tags.sidewalk} side${tags.sidewalk === 'both' ? 's' : ''}`); }

  if (!relevant) return null;
  const surface_type = tags.surface === 'mud' ? 'mud' : /paving_stones|sett|cobblestone|unhewn/.test(tags.surface || '') ? 'paver' : /concrete/.test(tags.surface || '') ? 'concrete' : /asphalt/.test(tags.surface || '') ? 'asphalt' : BAD_SURFACES.has(tags.surface) ? 'none' : 'none';
  return {
    surface_type,
    hazards,
    estimated_clear_width_m: width,
    observations: `From OpenStreetMap tags${notes.length ? ': ' + notes.join(', ') : ''}. Not yet photographed.`,
  };
}

function scoreRoute(coords, segments, { sampleEveryM = 25, radiusM = 40 } = {}) {
  const points = coords.map(([lng, lat]) => ({ lat, lng }));
  const cands = segments.map((s) => {
    const c = segmentCoords(s);
    return { seg: s, coords: c, bbox: padBbox(bboxOf(c), radiusM) };
  });

  // resample along the polyline
  const samples = [];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d = haversine(a, b);
    if (d === 0) continue;
    let t = carry;
    while (t <= d) {
      const f = t / d;
      samples.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
      t += sampleEveryM;
    }
    carry = t - d;
  }
  if (!samples.length && points.length) samples.push(points[0]);

  let covered = 0;
  let weighted = 0;
  let weight = 0;
  const hit = new Map();
  for (const p of samples) {
    let any = false;
    for (const c of cands) {
      const b = c.bbox;
      if (p.lat < b.min_lat || p.lat > b.max_lat || p.lng < b.min_lng || p.lng > b.max_lng) continue; // cheap reject
      if (pointToPolylineM(p, c.coords) <= radiusM) {
        any = true;
        weighted += c.seg.score * c.seg.length_m;
        weight += c.seg.length_m;
        hit.set(c.seg.id, c.seg);
      }
    }
    if (any) covered++;
  }
  const coverage = samples.length ? Math.round((covered / samples.length) * 100) : 0;
  const score = weight ? Math.round(weighted / weight) : null;
  return { score, coverage, samples: samples.length, segments: [...hit.values()] };
}

module.exports = {
  haversine, polylineLength, bboxOf, padBbox, pointToPolylineM, segmentCoords, distanceToLine,
  enrichHazard, scoreFromHazards, personaVerdicts, gradeSegment, scoreRoute, tagsToObservation, TYPES, STANDARDS,
};
