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

  // Raster tiles. The server tells us which host to use (/api/config → RASTA_TILE_URL) because the
  // public openstreetmap.org tiles are for development only. A CSS filter on the tile pane pulls
  // any light basemap into the slate register (see .leaflet-tile-pane).
  const DEFAULT_TILES = { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' };
  let tileLayer = null;
  let tileErrors = 0;
  function setTiles({ url, attribution, maxZoom = 19 }) {
    if (tileLayer) { if (tileLayer._url === url) return; map.removeLayer(tileLayer); }
    tileLayer = L.tileLayer(url, { maxZoom, attribution });
    tileLayer.on('tileerror', () => {
      tileErrors++;
      if (tileErrors === 8) window.dispatchEvent(new CustomEvent('rasta:notice', { detail: { text: 'Map tiles are not loading. Check the connection; footpaths still work.', kind: 'error' } }));
    });
    tileLayer.addTo(map);
  }
  setTiles(DEFAULT_TILES);
  fetch('/api/config').then((r) => r.json()).then((c) => { if (c && c.tile_url) setTiles({ url: c.tile_url, attribution: c.tile_attribution || DEFAULT_TILES.attribution }); }).catch(() => {});

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
      L.polyline(latlngs, { color: '#0F172A', weight: 12, opacity: .9, className: 'seg-casing', interactive: false }).addTo(casing);
      const line = L.polyline(latlngs, { color: lensColor(p), weight: 7, opacity: 1, className: 'seg-line', lineCap: 'round' })
        .bindTooltip(`<b>${p.score}</b> ${escapeHtml(p.name)}`, { className: 'seg-tip', direction: 'top', sticky: true, opacity: 1 })
        .on('mouseover', () => line.setStyle({ weight: 10 }))
        .on('mouseout', () => { if (selectedId !== p.id) line.setStyle({ weight: 7 }); })
        .on('click', (e) => { L.DomEvent.stopPropagation(e); select(p.id, true); })
        .addTo(lines);
      byId.set(p.id, { line, props: p, latlngs });
    }
    if (selectedId != null && !byId.has(selectedId)) selectedId = null;
  }

  function setLens(next) {
    lens = next;
    for (const { line, props } of byId.values()) line.setStyle({ color: lensColor(props) });
  }

  function select(id, fromMap) {
    selectedId = id;
    for (const [sid, { line }] of byId) {
      line.setStyle({ weight: sid === id ? 10 : 7 });
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
      L.polyline(latlngs, { color: '#0F172A', weight: 11, opacity: .8, interactive: false }).addTo(routeLayer);
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
    getFeatures: () => features,
  };
})();
