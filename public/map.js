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
      const gl = L.maplibreGL({ style: spec.url, attribution: spec.attribution, interactive: false });
      baseLayer = gl.addTo(map);
      let ready = false;
      const fallback = (why) => {
        if (ready || baseLayer !== gl) return;
        ready = true;
        map.removeLayer(gl);
        baseLayer = rasterLayer(!spec.light).addTo(map);
        noticeOnce(`Vector map failed (${why}), using OpenStreetMap tiles`, 'error');
      };
      try {
        const m = gl.getMaplibreMap();
        m.once('load', () => { ready = true; });
        m.on('error', (e) => { if (!ready && e?.error && /style|Failed to fetch|NetworkError|404|5\d\d/i.test(String(e.error.message || e.error))) fallback('style did not load'); });
        setTimeout(() => { if (!ready) fallback('timed out'); }, 8000);
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

  // ---------- segments ----------
  const casing = L.layerGroup().addTo(map);
  const lines = L.layerGroup().addTo(map);
  const byId = new Map();
  let features = [];
  let lens = 'score';
  let onSelect = null;
  let selectedId = null;

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
        .bindTooltip(`<b>${p.score}</b> ${escapeHtml(p.name)}${osm ? ' <small>· OSM tags</small>' : ''}`, { className: 'seg-tip', direction: 'top', sticky: true, opacity: 1 })
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
  function clearSelection() { select(null); }

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
  function clearRoutes() { routeLayer.clearLayers(); routeLines = []; }

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
    locate, invalidate: () => map.invalidateSize(),
    setBasemap, getBasemap: () => basemap, setOnBasemapChange: (fn) => { onBasemapChange = fn; }, enableGoogle,
    getBounds: () => { const b = map.getBounds(); return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }; },
    getZoom: () => map.getZoom(),
    getFeatures: () => features,
  };
})();
