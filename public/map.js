/* map.js — Leaflet setup, segment rendering, point picking, route drawing.
   Exposes window.RastaMap. No framework. */
(function () {
  const DELHI = [28.6448, 77.2167];
  const COLORS = { red: '#DC2626', amber: '#F59E0B', green: '#22C55E', nodata: '#64748B' };

  function scoreColor(score) {
    if (score == null) return COLORS.nodata;
    if (score < 40) return COLORS.red;
    if (score <= 70) return COLORS.amber;
    return COLORS.green;
  }

  const map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: false, tap: true })
    .setView(DELHI, 13);

  // ---------- basemaps ----------
  // Vector tiles from OpenFreeMap (free, no key) rendered by MapLibre inside a
  // Leaflet pane. If WebGL or the style fails, we drop to OSM raster tiles.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const STYLES = {
    dark: { url: 'https://tiles.openfreemap.org/styles/dark', attribution: `${OSM_ATTR} &copy; <a href="https://openfreemap.org">OpenFreeMap</a>`, casing: '#0B1120', light: false },
    light: { url: 'https://tiles.openfreemap.org/styles/positron', attribution: `${OSM_ATTR} &copy; <a href="https://openfreemap.org">OpenFreeMap</a>`, casing: '#FFFFFF', light: true },
    streets: { raster: true, casing: '#FFFFFF', light: true },
    google: { google: true, casing: '#0B1120', light: false },
  };
  let googleKey = null;
  // Slate night styling for Google's roadmap so it sits in the same register.
  const GOOGLE_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#111a2e' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8a9bb5' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#0f172a' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#22304a' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#0f172a' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#33445f' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b1324' }] },
    { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#121d31' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#132033' }] },
  ];
  let googleLoading = null;
  function loadGoogle() {
    if (window.google?.maps) return Promise.resolve();
    if (googleLoading) return googleLoading;
    googleLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleKey)}&v=weekly&loading=async&callback=__rastaGoogleReady`;
      window.__rastaGoogleReady = () => resolve();
      el.onerror = () => reject(new Error('Google Maps script failed to load'));
      document.head.appendChild(el);
      setTimeout(() => reject(new Error('Google Maps timed out')), 10000);
    });
    return googleLoading;
  }
  function enableGoogle(key) {
    googleKey = key;
    const btn = document.querySelector('[data-basemap="google"]');
    if (btn) btn.hidden = !key;
  }
  let baseLayer = null;
  let basemap = null;
  let onBasemapChange = null;

  // Raster tiles come from the host the server configures (/api/config → RASTA_TILE_URL), because
  // openstreetmap.org's public tiles are for development only. detectRetina asks for one zoom level
  // deeper on HiDPI screens so raster tiles are crisp instead of upscaled.
  const RASTER = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTR };
  function rasterLayer(mono) {
    return L.tileLayer(RASTER.url, { maxZoom: 19, maxNativeZoom: 19, detectRetina: true, attribution: RASTER.attribution, className: mono ? 'tiles-mono' : '' });
  }
  function setTiles({ url, attribution }) {
    if (!url || (url === RASTER.url && (!attribution || attribution === RASTER.attribution))) return;
    RASTER.url = url; RASTER.attribution = attribution || OSM_ATTR;
    if (baseLayer && baseLayer instanceof L.TileLayer) setBasemap(basemap); // re-add with the new host
  }
  fetch('/api/config').then((r) => r.json()).then((c) => { if (c && c.tile_url) setTiles({ url: c.tile_url, attribution: c.tile_attribution }); }).catch(() => {});

  function notice(text, kind) { window.dispatchEvent(new CustomEvent('rasta:notice', { detail: { text, kind } })); }
  let noticed = false;
  function noticeOnce(text, kind) { if (!noticed) { noticed = true; notice(text, kind); } }
  let webgl = null;
  function hasWebGL() {
    if (webgl != null) return webgl;
    try { const c = document.createElement('canvas'); webgl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { webgl = false; }
    return webgl;
  }

  function setBasemap(name) {
    if (!STYLES[name]) name = 'dark';
    const spec = STYLES[name];
    if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
    basemap = name;
    try { localStorage.setItem('rasta.basemap', name); } catch {}
    document.body.classList.toggle('map-light', !!spec.light);
    document.body.dataset.basemap = name;

    if (spec.google) {
      if (!googleKey || !L.gridLayer?.googleMutant) { setBasemap('dark'); return; }
      const g = L.gridLayer.googleMutant({ type: 'roadmap', styles: GOOGLE_STYLE, maxZoom: 21 });
      baseLayer = g.addTo(map);
      loadGoogle().catch((err) => { if (baseLayer === g) { notice(`${err.message}; showing the dark map instead`, 'error'); setBasemap('dark'); } });
    } else if (spec.raster || !window.maplibregl || !L.maplibreGL || !hasWebGL()) {
      baseLayer = rasterLayer(!spec.light).addTo(map);
      if (!spec.raster) noticeOnce('Vector map unavailable on this device, using OpenStreetMap tiles', 'error');
    } else {
      // Raster tiles go underneath straight away so the map is never blank while the vector
      // style downloads; they are removed once the style has painted.
      const under = rasterLayer(!spec.light); under.addTo(map); under.getContainer()?.classList.add('tiles-under');
      const gl = L.maplibreGL({ style: spec.url, attribution: spec.attribution, interactive: false });
      baseLayer = gl.addTo(map);
      let ready = false;
      const fallback = (why, quiet) => {
        if (ready || baseLayer !== gl) return;
        ready = true;
        map.removeLayer(gl);
        under.getContainer()?.classList.remove('tiles-under');
        baseLayer = under;
        if (!quiet) noticeOnce(`Vector map failed (${why}), using OpenStreetMap tiles`, 'error');
      };
      try {
        const m = gl.getMaplibreMap();
        m.once('idle', () => { ready = true; if (baseLayer === gl && map.hasLayer(under)) setTimeout(() => map.removeLayer(under), 400); });
        m.on('error', (e) => { if (!ready && e?.error && /style|Failed to fetch|NetworkError|404|5\d\d/i.test(String(e.error.message || e.error))) fallback('style did not load'); });
        m.on('webglcontextlost', () => { ready = false; fallback('graphics context lost'); });
        setTimeout(() => { if (!ready) fallback('timed out', true); }, 10000); // raster is already showing, no need to alarm anyone
      } catch (err) { fallback(err.message); }
    }
    restyleCasing();
    for (const b of document.querySelectorAll('[data-basemap]')) { const on = b.dataset.basemap === name; b.classList.toggle('is-active', on); b.setAttribute('aria-checked', on); }
    onBasemapChange && onBasemapChange(name, spec);
  }
  const casingColor = () => (STYLES[basemap] || STYLES.dark).casing;
  function restyleCasing() {
    casing.eachLayer((l) => l.setStyle({ color: casingColor() }));
  }

  // Leaflet caches its container size; anything that changes layout without a window resize
  // (the intro shutter, the phone sheet, tab switches, returning to the tab) needs a nudge.
  const nudge = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => map.invalidateSize({ pan: false }), 60); }; })();
  if (window.ResizeObserver) new ResizeObserver(nudge).observe(document.getElementById('map'));
  for (const ev of ['load', 'pageshow', 'orientationchange', 'rasta:intro-done']) window.addEventListener(ev, nudge);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) nudge(); });

  // ---------- segments ----------
  const casing = L.layerGroup().addTo(map);
  const lines = L.layerGroup().addTo(map);
  const byId = new Map();
  let features = [];
  let lens = 'score';
  let onSelect = null;
  let selectedId = null;
  let labelFor = (id) => String(id).replace(/_/g, ' ');
  let tipStrings = { osm: 'from OSM tags', clear: 'no hazards recorded' };
  function setTypeLabels(fn, strings) { labelFor = fn; if (strings) tipStrings = { ...tipStrings, ...strings }; }
  function tooltipHtml(p) {
    const top = p.top_hazards || [];
    const bad = top.some((h) => h.severity >= 4);
    const line = top.length ? top.map((h) => `${escapeHtml(labelFor(h.type_id))}${h.n > 1 ? ` ×${h.n}` : ''}`).join(' · ') : tipStrings.clear;
    return `<b>${p.score}</b> ${escapeHtml(p.name)}${p.source === 'osm' ? ` <span style="color:var(--ink-faint)">· ${tipStrings.osm}</span>` : ''}<small class="${bad ? 'bad' : ''}">${line}</small>`;
  }

  function lensColor(props) {
    if (lens === 'score') return scoreColor(props.score);
    const v = props.verdicts && props.verdicts[lens];
    return v && v.ok ? COLORS.green : COLORS.red;
  }

  function renderSegments(geojson) {
    features = geojson.features || [];
    casing.clearLayers(); lines.clearLayers(); byId.clear();
    for (const f of features) {
      const latlngs = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const p = f.properties;
      const osm = p.source === 'osm'; // tag-derived: thinner, so photographed walks stand out
      const w = osm ? 4 : 7;
      L.polyline(latlngs, { color: casingColor(), weight: osm ? 8 : 13, opacity: .95, className: 'seg-casing', interactive: false }).addTo(casing);
      const line = L.polyline(latlngs, { color: lensColor(p), weight: w, opacity: osm ? .9 : 1, className: `seg-line${osm ? ' seg-osm' : ''}`, lineCap: 'round', lineJoin: 'round' })
        .bindTooltip(() => tooltipHtml(p), { className: 'seg-tip', direction: 'top', sticky: true, opacity: 1 })
        .on('mouseover', () => line.setStyle({ weight: w + 3 }))
        .on('mouseout', () => { if (selectedId !== p.id) line.setStyle({ weight: w }); })
        .on('click', (e) => { L.DomEvent.stopPropagation(e); select(p.id, true); })
        .addTo(lines);
      byId.set(p.id, { line, props: p, latlngs, w });
    }
    if (selectedId != null && !byId.has(selectedId)) selectedId = null;
  }

  function setLens(next) {
    lens = next;
    for (const { line, props } of byId.values()) line.setStyle({ color: lensColor(props) });
  }

  function select(id, fromMap) {
    selectedId = id;
    for (const [sid, { line, w }] of byId) {
      line.setStyle({ weight: sid === id ? w + 3 : w });
      if (id != null) line.getElement()?.classList.toggle('is-dim', sid !== id);
      else line.getElement()?.classList.remove('is-dim');
    }
    if (id != null && onSelect) onSelect(id, fromMap);
  }
  function clearSelection() { select(null); clearHazardPins(); }

  // ---------- hazard pins: where along the stretch each hazard was seen ----------
  const pinLayer = L.layerGroup().addTo(map);
  const pinsById = new Map();
  function clearHazardPins() { pinLayer.clearLayers(); pinsById.clear(); }
  function pointAlong(latlngs, frac) {
    if (latlngs.length === 1) return latlngs[0];
    const seg = []; let total = 0;
    for (let i = 0; i < latlngs.length - 1; i++) { const d = map.distance(latlngs[i], latlngs[i + 1]); seg.push(d); total += d; }
    let target = Math.max(0, Math.min(1, frac)) * total;
    for (let i = 0; i < seg.length; i++) {
      if (target <= seg[i] || i === seg.length - 1) {
        const f = seg[i] ? target / seg[i] : 0;
        const a = L.latLng(latlngs[i]), b = L.latLng(latlngs[i + 1]);
        return [a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f];
      }
      target -= seg[i];
    }
    return latlngs[latlngs.length - 1];
  }
  // seg: full segment from /api/segments/:id. Photo GPS places a pin exactly; otherwise pins are
  // spread along the line in photo order so the map still says roughly where the damage is.
  function showHazardPins(seg) {
    clearHazardPins();
    const s = byId.get(seg.id);
    const latlngs = s ? s.latlngs : (seg.geometry?.coordinates || [[seg.start.lng, seg.start.lat], [seg.end.lng, seg.end.lat]]).map(([lng, lat]) => [lat, lng]);
    const photos = seg.photos || [];
    const byPhoto = new Map();
    for (const h of seg.hazards) { const k = h.photo_id ?? 'none'; if (!byPhoto.has(k)) byPhoto.set(k, []); byPhoto.get(k).push(h); }
    const keys = [...byPhoto.keys()];
    let n = 0;
    seg.hazards.forEach((h, idx) => {
      if (h.status === 'cleared') return; // reported cleared: nothing to point at
      const k = h.photo_id ?? 'none';
      const photo = photos.find((p) => p.id === h.photo_id);
      const group = byPhoto.get(k); const j = group.indexOf(h);
      let ll;
      if (photo && photo.photo_lat != null && photo.photo_lng != null) ll = [photo.photo_lat, photo.photo_lng];
      else {
        const pi = Math.max(0, keys.indexOf(k));
        const base = (pi + 0.5) / keys.length;
        const spread = group.length > 1 ? ((j / (group.length - 1)) - 0.5) * (0.6 / keys.length) : 0;
        ll = pointAlong(latlngs, base + spread);
      }
      const cls = h.lifecycle?.key === 'recheck' ? 'recheck' : h.severity >= 4 ? 'hi' : h.severity <= 2 ? 'lo' : '';
      const icon = L.divIcon({ className: '', html: `<div class="hz-pin ${cls}" style="--d:${(n++ * 0.06).toFixed(2)}s" title="${escapeHtml(labelFor(h.type_id))}">${idx + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const m = L.marker(ll, { icon, keyboard: false, zIndexOffset: 500 }).addTo(pinLayer);
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); window.dispatchEvent(new CustomEvent('rasta:hazard-pin', { detail: { id: h.id, index: idx } })); });
      pinsById.set(h.id, m);
    });
  }
  function hotPin(id, on) {
    const node = m && m.getElement() ? m.getElement().querySelector('.hz-pin') : null;
    if (node) node.classList.toggle('is-hot', !!on);
  }

  function flyToSegment(id) {
    const s = byId.get(id);
    if (!s) return;
    map.flyToBounds(L.latLngBounds(s.latlngs).pad(0.6), { duration: .8, maxZoom: 17 });
  }

  function fitAll() {
    const all = [...byId.values()].flatMap((s) => s.latlngs);
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.15), { maxZoom: 15 });
  }

  let savedBasemap = 'dark';
  try { savedBasemap = localStorage.getItem('rasta.basemap') || 'dark'; } catch {}
  setBasemap(savedBasemap);
  document.querySelectorAll('[data-basemap]').forEach((b) => b.addEventListener('click', () => setBasemap(b.dataset.basemap)));

  // ---------- point picking (Contribute + Route) ----------
  const pickLayer = L.layerGroup().addTo(map);
  let pick = null; // { points: [], max, onChange, kind }

  function markerIcon(label, cls) {
    return L.divIcon({ className: '', html: `<div class="pt-marker ${cls}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  }

  function startPicking({ max = 2, kind = 'seg', onChange }) {
    pick = { points: [], max, onChange, kind };
    pickLayer.clearLayers();
    map.getContainer().style.cursor = 'crosshair';
  }
  function stopPicking() { pick = null; map.getContainer().style.cursor = ''; }
  function clearPicks() { if (pick) { pick.points = []; pickLayer.clearLayers(); pick.onChange && pick.onChange([]); } else pickLayer.clearLayers(); }
  function setPicks(points) {
    if (!pick) return;
    pick.points = points.slice(0, pick.max);
    drawPicks();
    pick.onChange && pick.onChange(pick.points);
  }
  function drawPicks() {
    pickLayer.clearLayers();
    if (!pick) return;
    pick.points.forEach((p, i) => {
      const m = L.marker([p.lat, p.lng], { icon: markerIcon(i === 0 ? 'A' : 'B', (i === 0 ? '' : 'b ') + (pick.kind === 'route' ? 'route' : '')), draggable: true }).addTo(pickLayer);
      m.on('dragend', () => { const ll = m.getLatLng(); pick.points[i] = { lat: ll.lat, lng: ll.lng }; drawPicks(); pick.onChange && pick.onChange(pick.points); });
    });
    if (pick.kind === 'seg' && pick.points.length === 2) {
      L.polyline(pick.points.map((p) => [p.lat, p.lng]), { color: '#F59E0B', weight: 4, dashArray: '6 8', opacity: .9, interactive: false }).addTo(pickLayer);
    }
  }
  map.on('click', (e) => {
    if (!pick) { clearSelection(); window.dispatchEvent(new CustomEvent('rasta:mapclick')); return; }
    if (pick.points.length >= pick.max) pick.points = [];
    pick.points.push({ lat: e.latlng.lat, lng: e.latlng.lng });
    drawPicks();
    pick.onChange && pick.onChange(pick.points);
  });

  // ---------- routes ----------
  const routeLayer = L.layerGroup().addTo(map);
  let routeLines = [];
  function clearRoutes() { routeLayer.clearLayers(); routeLines = []; if (typeof clearRouteHazards === 'function') clearRouteHazards(); if (typeof stopWalk === 'function') stopWalk(); }

  function drawRoutes(routes, { onClick, recommended } = {}) {
    clearRoutes();
    const bounds = L.latLngBounds([]);
    routes.forEach((r, i) => {
      const latlngs = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      latlngs.forEach((ll) => bounds.extend(ll));
      const covered = r.coverage >= 40 && r.score != null;
      const color = covered ? scoreColor(r.score) : COLORS.nodata;
      L.polyline(latlngs, { color: casingColor(), weight: 11, opacity: .85, interactive: false }).addTo(routeLayer);
      const line = L.polyline(latlngs, {
        color, weight: i === recommended ? 7 : 5, opacity: 1, className: 'route-line',
        dashArray: covered ? null : '2 10',
      }).on('click', () => onClick && onClick(i)).addTo(routeLayer);
      routeLines.push(line);
      // animate the draw for solid lines
      const el = line.getElement();
      if (el && covered && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const len = el.getTotalLength ? el.getTotalLength() : 0;
        if (len) {
          el.style.setProperty('--len', len);
          el.style.strokeDasharray = len;
          el.style.strokeDashoffset = len;
          el.classList.add('is-drawing');
          el.addEventListener('animationend', () => { el.classList.remove('is-drawing'); el.style.strokeDasharray = ''; el.style.strokeDashoffset = ''; }, { once: true });
        }
      }
    });
    if (bounds.isValid()) map.flyToBounds(bounds.pad(0.2), { duration: .8 });
  }
  function highlightRoute(i) {
    routeLines.forEach((l, j) => { l.getElement()?.classList.toggle('is-dim', i != null && j !== i); l.setStyle({ weight: j === i ? 8 : 5 }); });
  }

  // ---------- problems along a route: numbered pins ----------
  const hazardLayer = L.layerGroup().addTo(map);
  let hazardPins = [];
  function clearRouteHazards() { hazardLayer.clearLayers(); hazardPins = []; }
  function drawRouteHazards(problems, { onClick } = {}) {
    clearRouteHazards();
    (problems || []).forEach((p, i) => {
      if (p.lat == null || p.lng == null) return;
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: '', html: `<div class="hz-pin sev-${p.severity}" data-pin="${i}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 500, keyboard: false,
      }).bindTooltip(`<b>${p.severity}/5</b> ${escapeHtml(p.label_en || p.type_id)}<br><small>${escapeHtml(p.segment_name || '')}</small>`, { className: 'seg-tip', direction: 'top', opacity: 1 })
        .on('click', () => onClick && onClick(i)).addTo(hazardLayer);
      hazardPins.push(m);
    });
  }
  function highlightRouteHazard(i, fly) {
    hazardPins.forEach((m, j) => m.getElement()?.querySelector('.hz-pin')?.classList.toggle('is-hot', j === i));
    if (fly && hazardPins[i]) { map.flyTo(hazardPins[i].getLatLng(), Math.max(map.getZoom(), 17), { duration: .6 }); hazardPins[i].openTooltip(); }
  }

  // ---------- "start walking": zoom in and follow the route ----------
  const walkLayer = L.layerGroup().addTo(map);
  let walker = null;
  function stopWalk() { if (walker) walker.stop(); }
  /**
   * Animate a marker along `coords` ([lng,lat]) at a screen speed of ~45 m/s (10–60 s total), with
   * the camera following. `problems` ([{lat,lng}]) fire onNear(index, problem) the first time the
   * walker comes within 40 m. Returns { stop }. Respects prefers-reduced-motion (jumps, no fly).
   */
  function walkAlong(coords, { speedMps = 1.35, problems = [], onProgress, onNear, onDone, zoom = 18 } = {}) {
    stopWalk();
    const pts = coords.map(([lng, lat]) => L.latLng(lat, lng));
    if (pts.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
    const total = cum[cum.length - 1];
    const durationMs = Math.min(60000, Math.max(10000, (total / 45) * 1000));
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const marker = L.marker(pts[0], { icon: L.divIcon({ className: '', html: '<div class="walker"><i></i></div>', iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false, zIndexOffset: 1000 }).addTo(walkLayer);
    const trail = L.polyline([pts[0]], { color: '#F59E0B', weight: 5, opacity: .95, interactive: false, lineCap: 'round' }).addTo(walkLayer);
    const seen = new Set();
    let raf = null, start = null, stopped = false;
    const step = (now) => {
      if (stopped) return;
      if (start == null) start = now;
      const f = Math.min(1, (now - start) / durationMs);
      const d = f * total;
      let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
      const a = pts[i - 1], b = pts[i], segLen = cum[i] - cum[i - 1] || 1, tt = Math.min(1, Math.max(0, (d - cum[i - 1]) / segLen));
      const ll = L.latLng(a.lat + (b.lat - a.lat) * tt, a.lng + (b.lng - a.lng) * tt);
      marker.setLatLng(ll); trail.addLatLng(ll); map.panTo(ll, { animate: false });
      problems.forEach((p, k) => { if (!seen.has(k) && p.lat != null && ll.distanceTo([p.lat, p.lng]) < 40) { seen.add(k); onNear && onNear(k, p); } });
      onProgress && onProgress({ done_m: d, total_m: total, fraction: f, remaining_s: (total - d) / speedMps });
      if (f < 1) raf = requestAnimationFrame(step); else { walker = null; onDone && onDone({ total_m: total, problems_seen: seen.size }); }
    };
    const begin = () => { if (!stopped) raf = requestAnimationFrame(step); };
    if (reduce) { map.setView(pts[0], zoom, { animate: false }); begin(); }
    else { map.once('moveend', begin); map.flyTo(pts[0], zoom, { duration: 1.2 }); }
    walker = { stop() { stopped = true; if (raf) cancelAnimationFrame(raf); map.off('moveend', begin); walkLayer.clearLayers(); walker = null; } };
    return walker;
  }

  // ---------- locate ----------
  let meMarker = null;
  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Location is not available in this browser'));
      navigator.geolocation.getCurrentPosition((pos) => {
        const ll = [pos.coords.latitude, pos.coords.longitude];
        if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), interactive: false }).addTo(map);
        else meMarker.setLatLng(ll);
        map.flyTo(ll, 17, { duration: .8 });
        resolve({ lat: ll[0], lng: ll[1] });
      }, (err) => reject(new Error(err.code === 1 ? 'Location permission was denied' : 'Could not get your location')), { enableHighAccuracy: true, timeout: 8000 });
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  window.RastaMap = {
    map, scoreColor, COLORS, setTiles,
    renderSegments, setLens, select, clearSelection, flyToSegment, fitAll, setOnSelect: (fn) => { onSelect = fn; },
    startPicking, stopPicking, clearPicks, setPicks,
    drawRoutes, clearRoutes, highlightRoute,
    drawRouteHazards, clearRouteHazards, highlightRouteHazard, walkAlong, stopWalk, isWalking: () => !!walker,
    locate, invalidate: () => map.invalidateSize(),
    setTypeLabels, showHazardPins, clearHazardPins, hotPin,
    setBasemap, getBasemap: () => basemap, setOnBasemapChange: (fn) => { onBasemapChange = fn; }, enableGoogle,
    getBounds: () => { const b = map.getBounds(); return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }; },
    getZoom: () => map.getZoom(),
    getFeatures: () => features,
  };
})();
