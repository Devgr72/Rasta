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
function gradeSegment({ name, start, end }, photoResults) {
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
    length_m: Math.round(haversine(start, end)),
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

/** Score a route polyline against graded segments. coords: [[lng,lat],...] */
function scoreRoute(coords, segments, { sampleEveryM = 25, radiusM = 40 } = {}) {
  const points = coords.map(([lng, lat]) => ({ lat, lng }));
  const mids = segments.map((s) => ({
    seg: s,
    mid: { lat: (s.start.lat + s.end.lat) / 2, lng: (s.start.lng + s.end.lng) / 2 },
    reach: Math.max(radiusM, s.length_m / 2), // long segments count along their whole run
  }));

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
    for (const m of mids) {
      if (haversine(p, m.mid) <= m.reach) {
        any = true;
        weighted += m.seg.score * m.seg.length_m;
        weight += m.seg.length_m;
        hit.set(m.seg.id, m.seg);
      }
    }
    if (any) covered++;
  }
  const coverage = samples.length ? Math.round((covered / samples.length) * 100) : 0;
  const score = weight ? Math.round(weighted / weight) : null;
  return { score, coverage, samples: samples.length, segments: [...hit.values()] };
}

module.exports = { haversine, enrichHazard, scoreFromHazards, personaVerdicts, gradeSegment, scoreRoute, TYPES, STANDARDS };
