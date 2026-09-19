/* app.js — all frontend logic. Three tabs, show/hide only. */
(function () {
  const M = window.RastaMap;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isPhone = () => matchMedia('(max-width: 860px)').matches;

  const state = {
    tab: 'map',
    standards: null,
    types: {},
    lens: 'score',
    stats: null,
    segPoints: [],
    photos: [], // { id, file, url, blob }
    analysing: false,
    lastSegmentId: null,
    routePoints: [],
    persona: 'walk',
    routes: null,
    sheetExpanded: false,
  };

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtINR(n) {
    n = Math.round(Number(n) || 0);
    if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
    if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
    return `₹${n.toLocaleString('en-IN')}`;
  }
  const fmtLL = (p) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  function haversine(a, b) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`; el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, kind === 'error' ? 6000 : 3500);
  }
  window.addEventListener('rasta:notice', (e) => toast(e.detail.text, e.detail.kind));

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    return data;
  }

  function countUp(el, to, { ms = 900, fmt = (v) => Math.round(v) } = {}) {
    if (reduceMotion) { el.textContent = fmt(to); return Promise.resolve(); }
    const from = Number(el.dataset.v || 0);
    const t0 = performance.now();
    return new Promise((res) => {
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
        el.textContent = fmt(from + (to - from) * e);
        if (k < 1) requestAnimationFrame(step); else { el.dataset.v = to; res(); }
      };
      requestAnimationFrame(step);
    });
  }

  const typeLabel = (id) => state.types[id]?.label_en || id.replace(/_/g, ' ');
  const typeLabelHi = (id) => state.types[id]?.label_hi || '';

  const PERSONA_ICON = {
    walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M11 8l-3 6 3 2 1 6M11 8l4 3 3-1M11 8l-4 4"/></svg>',
    wheelchair: '<svg viewBox="0 0 24 24"><circle cx="9" cy="19" r="4"/><circle cx="12" cy="4" r="2"/><path d="M12 7v6h6l3 6M9 15h5"/></svg>',
    senior: '<svg viewBox="0 0 24 24"><circle cx="12" cy="4" r="2"/><path d="M12 7v7l-3 8M12 14l3 8M12 9l5 2M7 22V11"/></svg>',
  };
  const PERSONA_NAME = { walk: 'Walking', wheelchair: 'Wheelchair', senior: 'Senior' };

  function verdictsHtml(verdicts) {
    return ['walk', 'wheelchair', 'senior'].map((k) => {
      const v = verdicts[k];
      return `<li class="${v.ok ? 'pass' : 'fail'}">${PERSONA_ICON[k]}<b>${PERSONA_NAME[k]}<small>${v.ok ? 'passes' : 'blocked'}</small></b><span>${esc(v.reason)}</span></li>`;
    }).join('');
  }

  // Draw boxes onto a .shot element with a stagger. Returns when all landed.
  async function landBoxes(shot, hazards, { stagger = 150, onEach } = {}) {
    const target = shot.querySelector('.img-wrap') || shot;
    const boxed = hazards.filter((h) => h.bbox);
    const crowded = boxed.length > 3; // numbered chips read better than eight overlapping labels
    for (const [i, h] of hazards.entries()) {
      if (!h.bbox) continue;
      const b = h.bbox;
      const el = document.createElement('div');
      el.className = `box sev-${h.severity}${b.y + b.h > 0.82 ? ' flip' : ''}${crowded ? ' num' : ''}`;
      el.style.cssText = `left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
      el.dataset.hazard = h.id ?? `${i}`;
      el.title = `${typeLabel(h.type_id)} · severity ${h.severity}`;
      el.innerHTML = `<i></i><span>${crowded ? boxed.indexOf(h) + 1 : `${esc(typeLabel(h.type_id))} · ${h.severity}`}</span>`;
      target.appendChild(el);
      await sleep(reduceMotion ? 0 : stagger);
      el.classList.add('is-in');
      onEach && onEach(h, i);
    }
  }

  // ---------- tabs ----------
  function setTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); });
    $$('.view').forEach((v) => { const on = v.id === `view-${tab}`; v.classList.toggle('is-active', on); v.hidden = !on; });
    $('#map-tools').hidden = tab !== 'map';
    $('#legend').hidden = tab === 'contribute';
    M.clearRoutes();
    if (tab === 'contribute') {
      M.startPicking({ max: 2, kind: 'seg', onChange: onSegPoints });
      M.setPicks(state.segPoints);
      M.clearSelection();
    } else if (tab === 'route') {
      M.startPicking({ max: 2, kind: 'route', onChange: onRoutePoints });
      M.setPicks(state.routePoints);
      M.clearSelection();
      if (state.routes) renderRoutes(state.routes);
    } else {
      M.stopPicking(); M.clearPicks();
      M.setLens(state.lens);
    }
    if (tab !== 'map') M.setLens('score');
    setSheet(false);
    setTimeout(M.invalidate, 320);
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- mobile sheet ----------
  function setSheet(expanded) {
    state.sheetExpanded = expanded;
    $('#panel').classList.toggle('is-expanded', expanded);
    setTimeout(M.invalidate, 320);
  }
  (function sheetDrag() {
    const h = $('#sheet-handle');
    let y0 = null;
    h.addEventListener('click', () => setSheet(!state.sheetExpanded));
    h.addEventListener('pointerdown', (e) => { y0 = e.clientY; });
    h.addEventListener('pointerup', (e) => { if (y0 == null) return; const dy = e.clientY - y0; if (Math.abs(dy) > 24) setSheet(dy < 0); y0 = null; });
  })();

  // ---------- ledger + lens ----------
  async function loadStats() {
    try {
      const s = await api('/api/stats');
      state.stats = s;
      const set = (k, v, fmt) => { const el = $(`[data-stat="${k}"]`); if (el) countUp(el, v, { fmt }); };
      set('segments', s.segments); set('hazards', s.hazards);
      set('km_covered', s.km_covered, (v) => v.toFixed(1));
      set('total_cost_inr', s.total_cost_inr, fmtINR);
      const od = $('[data-stat-wrap="open_data_segments"]'); if (od) { od.hidden = !s.open_data_segments; set('open_data_segments', s.open_data_segments); }
      updateLensNote();
    } catch (err) { toast(`Stats unavailable: ${err.message}`, 'error'); }
  }
  function updateLensNote() {
    const el = $('#lens-note'); const s = state.stats; if (!s) return;
    const total = s.segments + (s.open_data_segments || 0);
    if (state.lens === 'score') el.innerHTML = `Coloured by accessibility score. Average across the map is <b>${s.avg_score}</b>.`;
    else if (state.lens === 'wheelchair') el.innerHTML = `<b>${s.wheelchair_ok_count} of ${total}</b> mapped footpaths can be used in a wheelchair.`;
    else if (state.lens === 'senior') el.innerHTML = `<b>${s.senior_ok_count} of ${total}</b> mapped footpaths are safe for an 80-year-old.`;
    else { const ok = M.getFeatures().filter((f) => f.properties.verdicts.walk.ok).length; el.innerHTML = `<b>${ok} of ${total}</b> mapped footpaths are passable on foot without a detour.`; }
  }
  $$('.lens-opt').forEach((b) => b.addEventListener('click', () => {
    state.lens = b.dataset.lens;
    $$('.lens-opt').forEach((x) => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-checked', on); });
    M.setLens(state.lens); updateLensNote();
    $('#legend').hidden = state.lens !== 'score';
  }));

  async function loadSegments() {
    try {
      const gj = await api('/api/segments');
      M.renderSegments(gj);
      return gj;
    } catch (err) { toast(`Could not load footpaths: ${err.message}`, 'error'); return null; }
  }

  // ---------- segment detail ----------
  M.setOnSelect(async (id) => {
    if (state.tab !== 'map') return;
    const host = $('#segment-detail');
    host.innerHTML = '<div class="empty"><p>Loading…</p></div>';
    if (isPhone()) setSheet(true);
    try {
      const seg = await api(`/api/segments/${id}`);
      renderSegment(seg, host);
    } catch (err) {
      host.innerHTML = `<div class="empty"><h2>Couldn't load this footpath.</h2><p>${esc(err.message)}</p></div>`;
    }
  });
  window.addEventListener('rasta:mapclick', () => { if (state.tab === 'map') showEmpty(); });

  function showEmpty() {
    $('#segment-detail').innerHTML = `<div class="empty"><h2>Tap a footpath.</h2><p>Every coloured line is a stretch someone walked and photographed. Tap one to see what they found, who can pass it, and what it would cost to fix.</p><p class="hint">Green passes. Amber slows people down. Red blocks a wheelchair or trips a senior.</p></div>`;
  }

  function complaintText(seg, h) {
    const t = state.types[h.type_id] || {};
    return `To: ${h.authority || t.authority || 'Municipal authority'}\nSubject: Footpath hazard — ${typeLabel(h.type_id)} at ${seg.name}\n\nLocation: ${fmtLL(seg.start)} to ${fmtLL(seg.end)}\nObservation: ${h.note || typeLabel(h.type_id)} (severity ${h.severity}/5)\nStandard: ${t.standard_ref || ''}\nIndicative repair cost: ${fmtINR(h.cost_inr)}\n\nThis hazard prevents safe use of the footpath by wheelchair users and senior citizens. Please inspect and rectify under the Harmonised Guidelines for Universal Accessibility (2021).\n\nReported via Rasta, ${new Date().toLocaleDateString('en-IN')}.`;
  }

  function renderSegment(seg, host) {
    const tpl = $('#tpl-segment').content.cloneNode(true);
    const el = (n) => tpl.querySelector(`[data-el="${n}"]`);
    const band = seg.score < 40 ? 'red' : seg.score <= 70 ? 'amber' : 'green';
    el('score').classList.add(band);
    el('score-num').textContent = seg.score;
    el('name').textContent = seg.name;
    const nPhotos = seg.photos.filter((p) => p.url).length;
    el('meta').textContent = `${seg.length_m} m · ${seg.hazards.length} hazard${seg.hazards.length === 1 ? '' : 's'} · ${nPhotos ? `${nPhotos} photo${nPhotos === 1 ? '' : 's'}` : seg.source === 'osm' ? 'from map tags' : 'no photos'}${seg.clear_width_m != null ? ` · ${seg.clear_width_m.toFixed(1)} m clear` : ''}`;
    el('verdicts').innerHTML = verdictsHtml(seg.verdicts);
    el('close').addEventListener('click', () => { M.clearSelection(); showEmpty(); if (isPhone()) setSheet(false); });
    el('report').href = `/report.html?id=${seg.id}`;
    el('walk').addEventListener('click', () => {
      const pts = [seg.start, seg.end];
      setTab('contribute'); M.setPicks(pts); $('#seg-name').value = seg.name.replace(/ \((footway|footpath|road|steps)\)$/, '');
      $('[data-step="name"]').classList.add('is-done'); M.flyToSegment(seg.id);
      toast('Points set from this stretch. Add photos to verify it.', 'ok');
    });
    if (seg.source === 'commons' || seg.source === 'mapillary') {
      const src = el('source'); src.hidden = false;
      src.innerHTML = `Graded from openly licensed photos on ${seg.source === 'mapillary' ? 'Mapillary' : 'Wikimedia Commons'} taken at this spot. Walk it to add a current reading.`;
    }
    if (seg.source === 'osm') {
      const src = el('source'); src.hidden = false;
      src.innerHTML = `Graded from <a href="https://www.openstreetmap.org/way/${seg.osm_id}" target="_blank" rel="noopener">OpenStreetMap tags</a>, not yet photographed. Walk it to confirm what is on the ground.`;
      el('walk').textContent = 'Verify this stretch with photos';
    }
    // other readings of the same stretch
    (async () => {
      try {
        const mid = { lat: (seg.start.lat + seg.end.lat) / 2, lng: (seg.start.lng + seg.end.lng) / 2 };
        const r = await api(`/api/segments/near?lat=${mid.lat}&lng=${mid.lng}&r=60`);
        const others = r.segments.filter((s) => s.id !== seg.id);
        if (!others.length) return;
        const also = host.querySelector('[data-el="also"]'); if (!also) return;
        also.innerHTML = `<h3>Also mapped here</h3><ul>${others.slice(0, 5).map((s) => `<li><button type="button" data-view="${s.id}"><span class="sc" style="background:${M.scoreColor(s.score)}">${s.score}</span><span>${esc(s.name)}<br><small>${s.source === 'osm' ? 'OpenStreetMap tags' : `walked ${new Date(s.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`} · ${s.distance_m} m away</small></span></button></li>`).join('')}</ul>`;
        $$('[data-view]', also).forEach((b) => b.addEventListener('click', () => { const id = Number(b.dataset.view); M.flyToSegment(id); M.select(id); }));
      } catch {}
    })();

    // photos with boxes
    const photos = el('photos');
    const shots = new Map();
    if (!seg.photos.some((p) => p.url)) {
      photos.innerHTML = `<div class="shot none">${seg.source === 'osm' ? 'No photos yet. This grade comes from map tags alone.' : 'No photos on file for this stretch. Walk it again with the camera to add them.'}</div>`;
    }
    for (const p of seg.photos) {
      if (!p.url) continue;
      const shot = document.createElement('div');
      shot.className = 'shot';
      shot.classList.add('framed');
      shot.innerHTML = `<div class="img-wrap"><img src="${p.url}" alt="Footpath photo" loading="lazy">${p.status === 'mock' ? '<span class="badge mock">mock analysis</span>' : ''}${p.status === 'failed' ? '<span class="fail">Analysis failed for this photo</span>' : ''}</div>${p.credit ? `<div class="credit">Photo: ${esc(p.credit)} · ${esc(p.license || '')} · <a href="${esc(p.source_url || '#')}" target="_blank" rel="noopener">${p.source === 'mapillary' ? 'Mapillary' : 'Wikimedia Commons'}</a></div>` : ''}`;
      shot.querySelector('img').addEventListener('error', () => { shot.classList.add('none'); shot.innerHTML = 'Photo missing from disk'; });
      photos.appendChild(shot);
      shots.set(p.id, shot);
    }

    // hazards
    const hz = el('hazards');
    if (!seg.hazards.length) hz.innerHTML = `<p class="analyse-note" style="text-align:left">No hazards recorded. This is what a footpath should look like.</p>`;
    const perPhoto = {};
    for (const h of seg.hazards) { if (h.bbox) (perPhoto[h.photo_id] ||= []).push(h); }
    for (const h of seg.hazards) {
      const row = document.createElement('div');
      row.className = 'hz'; row.tabIndex = 0;
      const group = perPhoto[h.photo_id] || [];
      const chip = group.length > 3 ? `<small class="hz-n">${group.indexOf(h) + 1}</small>` : '';
      row.innerHTML = `<span class="hz-sev ${h.severity >= 4 ? 'hi' : h.severity <= 2 ? 'lo' : ''}">${h.severity}${chip}</span>
        <div><b>${esc(typeLabel(h.type_id))}<span class="hi-label">${esc(typeLabelHi(h.type_id))}</span></b><p>${esc(h.note || '')}</p><div class="auth">${esc(h.authority || '')} · ${esc(state.types[h.type_id]?.standard_ref || '')}</div><button type="button" class="hz-copy">Copy complaint draft</button></div>
        <span class="hz-cost">${h.cost_inr ? fmtINR(h.cost_inr) : 'enforce'}</span>`;
      const hot = (on) => { row.classList.toggle('is-hot', on); const shot = shots.get(h.photo_id); shot?.querySelectorAll('.box').forEach((b) => { b.style.opacity = on ? (b.dataset.hazard == h.id ? 1 : .15) : ''; }); };
      row.addEventListener('mouseenter', () => hot(true)); row.addEventListener('mouseleave', () => hot(false));
      row.addEventListener('focus', () => hot(true)); row.addEventListener('blur', () => hot(false));
      row.querySelector('.hz-copy').addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(complaintText(seg, h)); toast(`Complaint draft for ${h.authority || 'the authority'} copied`, 'ok'); }
        catch { toast('Clipboard blocked by the browser', 'error'); }
      });
      hz.appendChild(row);
    }

    // cost
    const byAuth = {};
    for (const h of seg.hazards) if (h.cost_inr) byAuth[h.authority || 'Other'] = (byAuth[h.authority || 'Other'] || 0) + h.cost_inr;
    el('cost').innerHTML = `<div class="cost-total"><span>To fix this stretch</span><b>${fmtINR(seg.total_cost_inr)}</b></div>
      <div class="cost-rows">${Object.entries(byAuth).sort((a, b) => b[1] - a[1]).map(([a, c]) => `<span>${esc(a)}<br><small style="color:var(--ink-faint)">${esc(state.standards?.authorities?.[a] || '')}</small></span><span>${fmtINR(c)}</span>`).join('') || '<span>No repair cost — enforcement only</span><span></span>'}</div>`;

    host.innerHTML = ''; host.appendChild(tpl);
    // land boxes after paint
    requestAnimationFrame(() => {
      for (const [pid, shot] of shots) landBoxes(shot, seg.hazards.filter((h) => h.photo_id === pid), { stagger: 150 });
    });
  }

  // ---------- contribute ----------
  const ptEls = { a: $('[data-pt="a"]'), b: $('[data-pt="b"]') };
  function onSegPoints(points) {
    state.segPoints = points;
    ['a', 'b'].forEach((k, i) => { const p = points[i]; ptEls[k].textContent = p ? fmtLL(p) : (i ? 'end' : 'start'); ptEls[k].parentElement.classList.toggle('is-set', !!p); });
    $('#points-len').innerHTML = points.length === 2 ? `<b>${Math.round(haversine(points[0], points[1]))} m</b> stretch` : '';
    $('#points-hint').textContent = points.length === 0 ? 'Tap the map where you started, then where you stopped.' : points.length === 1 ? 'Now tap where you stopped.' : 'Drag the markers to adjust.';
    $('[data-step="points"]').classList.toggle('is-done', points.length === 2);
    updateAnalyseState();
    checkNearby(points);
    $('#btn-open-photos').disabled = points.length !== 2 || state.analysing;
    if (points.length !== 2) { $('#open-list').hidden = true; state.openPhotos = null; }
  }

  // ---------- open photos: Wikimedia Commons / Mapillary photos taken at this stretch
  $('#btn-open-photos').addEventListener('click', async () => {
    const [a, b] = state.segPoints; if (!a || !b) return;
    const btn = $('#btn-open-photos'); btn.classList.add('is-busy'); btn.disabled = true; btn.querySelector('span').textContent = 'Searching open photo archives…';
    const list = $('#open-list');
    try {
      const r = await api(`/api/photos/open?lat=${a.lat}&lng=${a.lng}&lat2=${b.lat}&lng2=${b.lng}`);
      state.openPhotos = r.photos;
      list.hidden = false;
      if (!r.photos.length) { list.innerHTML = `<p>No openly licensed photos within reach of this stretch${r.mapillary_enabled ? '' : ' on Wikimedia Commons. Add a Mapillary token in .env to search street-level imagery too'}. Take your own.</p>`; return; }
      const selected = new Set(r.photos.slice(0, 6).map((_, i) => i));
      list.innerHTML = `<p>${r.photos.length} photo${r.photos.length === 1 ? '' : 's'} taken here, free to reuse. Tap to choose, then grade them exactly like your own.</p>
        <div class="open-grid">${r.photos.map((p, i) => `<button type="button" class="open-pick${selected.has(i) ? ' is-on' : ''}" data-i="${i}" title="${esc(p.title)} — ${esc(p.credit)}, ${esc(p.license)}"><img src="/api/img?u=${encodeURIComponent(p.url)}" alt="" loading="lazy"><span class="tick">✓</span><span class="d">${p.distance_m != null ? p.distance_m + ' m' : p.source}</span></button>`).join('')}</div>
        <div class="open-actions"><button type="button" class="primary" id="btn-grade-open">Grade <span id="open-count">${selected.size}</span> open photos</button><button type="button" class="ghost" id="btn-open-cancel">Close</button></div>`;
      $$('.open-pick', list).forEach((el) => el.addEventListener('click', () => { const i = Number(el.dataset.i); if (selected.has(i)) selected.delete(i); else if (selected.size < 8) selected.add(i); else toast('Up to 8 photos per stretch', 'error'); el.classList.toggle('is-on', selected.has(i)); $('#open-count').textContent = selected.size; $('#btn-grade-open').disabled = !selected.size; }));
      $('#btn-open-cancel').addEventListener('click', () => { list.hidden = true; });
      $('#btn-grade-open').addEventListener('click', () => gradeOpenPhotos([...selected].sort().map((i) => r.photos[i])));
    } catch (err) { toast(`Open photo search failed: ${err.message}`, 'error'); }
    finally { btn.classList.remove('is-busy'); btn.disabled = false; btn.querySelector('span').textContent = 'Find open photos of this stretch'; }
  });

  async function gradeOpenPhotos(photos) {
    if (state.analysing || state.segPoints.length !== 2 || !photos.length) return;
    state.analysing = true; updateAnalyseState();
    $('#open-list').hidden = true;
    // clear any uploaded photos: this run is the open set
    state.photos.forEach((p) => URL.revokeObjectURL(p.url)); state.photos = [];
    const strip = $('#photo-strip'); strip.innerHTML = ''; strip.classList.add('is-large');
    const ticker = $('#hazard-count'); ticker.textContent = '0'; let found = 0;
    $('#result').hidden = false;
    const name = $('#seg-name').value.trim() || 'Footpath from open photos';
    $('#result-name').textContent = name;
    $('#result-verdicts').innerHTML = ''; $('#result-cost').innerHTML = ''; $('.result-actions').style.visibility = 'hidden';
    $('#dial-num').textContent = '0'; $('#dial-num').dataset.v = 0; $('#dial-arc').style.strokeDashoffset = 400; $('#dial-cap').textContent = 'analysing';
    let segment = null; const landing = [];
    try {
      const r = await fetch('/api/segments/from-open-photos?stream=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, start: state.segPoints[0], end: state.segPoints[1], photos: photos.map((p) => ({ url: p.url, credit: p.credit, license: p.license, page: p.page, source: p.source })) }) });
      if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `${r.status}`); }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'start') {
            for (const t of msg.thumbs) { const shot = document.createElement('div'); shot.className = 'shot is-scanning'; shot.innerHTML = `<img src="${t}" alt=""><i class="scan"></i>`; strip.appendChild(shot); }
          } else if (msg.type === 'photo') {
            const p = msg.photo; const shot = $$('.shot', strip)[p.index]; if (!shot) continue;
            shot.classList.remove('is-scanning');
            if (p.status === 'failed') { shot.classList.add('is-failed'); shot.insertAdjacentHTML('beforeend', `<span class="fail">Couldn't analyse: ${esc(p.error || 'unknown')}</span>`); }
            if (p.credit) shot.insertAdjacentHTML('beforeend', `<div class="credit">Photo: ${esc(p.credit)} · ${esc(p.license || '')}</div>`);
            landing.push(landBoxes(shot, p.hazards, { stagger: 150, onEach: () => { found++; ticker.textContent = found; ticker.classList.add('tick'); setTimeout(() => ticker.classList.remove('tick'), 200); } }));
          } else if (msg.type === 'segment') segment = msg.segment;
          else if (msg.type === 'error') throw new Error(msg.error);
        }
      }
      if (!segment) throw new Error('No result came back');
      await Promise.all(landing);
      state.lastSegmentId = segment.id;
      $('#dial-cap').textContent = 'out of 100';
      const arc = $('#dial-arc'); arc.style.stroke = M.scoreColor(segment.score);
      arc.style.transition = reduceMotion ? 'none' : 'stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1), stroke .3s';
      requestAnimationFrame(() => { arc.style.strokeDashoffset = 400 - (400 * segment.score) / 100; });
      await countUp($('#dial-num'), segment.score, { ms: 1100 });
      $('#result-verdicts').innerHTML = verdictsHtml(segment.verdicts);
      const byAuth = Object.entries(segment.cost_by_authority || {}).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
      $('#result-cost').innerHTML = `<div class="cost-total"><span>To fix this stretch</span><b>${fmtINR(segment.total_cost_inr)}</b></div><div class="cost-rows">${byAuth.map(([a, c]) => `<span>${esc(a)}</span><span>${fmtINR(c)}</span>`).join('') || '<span>No repair cost</span><span></span>'}</div>`;
      $('.result-actions').style.visibility = '';
      $('#contribute-form').hidden = true;
      $('#result-strip-slot').appendChild(strip);
      await loadSegments(); loadStats();
      toast(`Added "${segment.name}" from ${photos.length} open photo${photos.length === 1 ? '' : 's'}`, 'ok');
    } catch (err) {
      $('#result').hidden = true; strip.classList.remove('is-large');
      const note = $('#analyse-note'); note.textContent = `Open photo grading failed: ${err.message}. Nothing was saved.`; note.classList.add('is-error');
      toast(`Open photo grading failed: ${err.message}`, 'error');
    } finally { state.analysing = false; if ($('#result').hidden) updateAnalyseState(); }
  }
  let nearbyTimer = null;
  function checkNearby(points) {
    const box = $('#nearby');
    clearTimeout(nearbyTimer);
    if (!points.length) { box.hidden = true; return; }
    const c = points.length === 2 ? { lat: (points[0].lat + points[1].lat) / 2, lng: (points[0].lng + points[1].lng) / 2 } : points[0];
    nearbyTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/segments/near?lat=${c.lat}&lng=${c.lng}&r=${points.length === 2 ? 60 : 80}`);
        if (!r.count) { box.hidden = true; return; }
        const walks = r.segments.filter((s) => s.source !== 'osm').length;
        box.hidden = false;
        box.innerHTML = `<b>Already mapped here.</b> ${walks ? `Walked ${walks} time${walks === 1 ? '' : 's'}` : 'Only OpenStreetMap tags so far'}${r.count > walks ? `, ${r.count - walks} from open data` : ''}. Your photos will add a fresh reading.
          <ul>${r.segments.slice(0, 3).map((s) => `<li><button type="button" data-view="${s.id}">${esc(s.name)}</button><span class="sc" style="color:${M.scoreColor(s.score)}">${s.score}</span></li>`).join('')}</ul>`;
        $$('[data-view]', box).forEach((b) => b.addEventListener('click', () => { const id = Number(b.dataset.view); setTab('map'); M.flyToSegment(id); setTimeout(() => M.select(id), 400); }));
      } catch { box.hidden = true; }
    }, 250);
  }
  $('#btn-clear-points').addEventListener('click', () => { M.clearPicks(); onSegPoints([]); });
  $('#seg-name').addEventListener('input', (e) => { $('[data-step="name"]').classList.toggle('is-done', e.target.value.trim().length > 2); });

  function updateAnalyseState() {
    const ok = state.segPoints.length === 2 && state.photos.length > 0 && !state.analysing;
    $('#btn-analyse').disabled = !ok;
    $('#analyse-count').textContent = state.photos.length ? `${state.photos.length} photo${state.photos.length > 1 ? 's' : ''}` : '';
    const note = $('#analyse-note');
    note.classList.remove('is-error');
    if (state.analysing) note.textContent = 'Analysing in parallel…';
    else if (state.segPoints.length < 2 && !state.photos.length) note.textContent = 'Mark two points and add at least one photo.';
    else if (state.segPoints.length < 2) note.textContent = 'Mark where the stretch starts and ends.';
    else if (!state.photos.length) note.textContent = 'Add at least one photo.';
    else note.textContent = `One model call per photo, all at once. Cached photos come back instantly.`;
    $('[data-step="photos"]').classList.toggle('is-done', state.photos.length > 0);
  }

  // Resize on-device so a 6 MB phone photo becomes ~300 KB before it leaves the phone.
  async function shrink(file, max = 1600) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (k === 1 && file.size < 1.5e6) return file;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
      return blob || file;
    } catch { return file; }
  }

  async function addFiles(files) {
    const room = 12 - state.photos.length;
    const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name)).slice(0, room);
    if ([...files].length > room) toast(`Only ${room} more photo${room === 1 ? '' : 's'} fit (12 max)`, 'error');
    for (const f of list) {
      const blob = await shrink(f);
      const url = URL.createObjectURL(blob);
      const id = Math.random().toString(36).slice(2);
      state.photos.push({ id, blob, url, name: f.name });
      const shot = document.createElement('div');
      shot.className = 'shot'; shot.dataset.id = id;
      shot.innerHTML = `<img src="${url}" alt=""><button type="button" class="rm" aria-label="Remove photo">×</button><i class="scan"></i>`;
      shot.querySelector('.rm').addEventListener('click', () => { state.photos = state.photos.filter((p) => p.id !== id); shot.remove(); URL.revokeObjectURL(url); updateAnalyseState(); });
      $('#photo-strip').appendChild(shot);
    }
    updateAnalyseState();
  }
  $('#photo-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  const dz = $('#dropzone');
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#photo-input').click(); } });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  function resetContribute() {
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    const strip = $('#photo-strip'); strip.innerHTML = ''; strip.classList.remove('is-large'); $('#strip-home').appendChild(strip);
    $('#seg-name').value = ''; $('[data-step="name"]').classList.remove('is-done');
    M.clearPicks(); onSegPoints([]);
    $('#result').hidden = true; $('#contribute-form').hidden = false;
    $('#hazard-count').textContent = '0'; $('#dial-num').textContent = '0'; $('#dial-num').dataset.v = 0;
    $('#dial-arc').style.strokeDashoffset = 400;
  }
  $('#btn-another').addEventListener('click', resetContribute);
  $('#btn-view-on-map').addEventListener('click', () => { const id = state.lastSegmentId; resetContribute(); setTab('map'); if (id != null) { M.flyToSegment(id); setTimeout(() => M.select(id), 400); } });

  $('#contribute-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.analysing || state.segPoints.length !== 2 || !state.photos.length) return;
    state.analysing = true; updateAnalyseState();
    const btn = $('#btn-analyse'); btn.classList.add('is-busy');
    const strip = $('#photo-strip'); strip.classList.add('is-large');
    $$('.shot', strip).forEach((s) => { s.classList.add('is-scanning'); s.querySelector('.rm').hidden = true; s.querySelectorAll('.box, .badge, .fail').forEach((b) => b.remove()); });
    const ticker = $('#hazard-count'); ticker.textContent = '0'; let found = 0;
    // results view shows immediately so the ticker is visible while boxes land
    $('#result').hidden = false;
    $('#result-name').textContent = $('#seg-name').value.trim() || 'Unnamed footpath';
    $('#result-verdicts').innerHTML = ''; $('#result-cost').innerHTML = ''; $('.result-actions').style.visibility = 'hidden';
    $('#dial-num').textContent = '0'; $('#dial-num').dataset.v = 0; $('#dial-arc').style.strokeDashoffset = 400; $('#dial-cap').textContent = 'analysing';

    const fd = new FormData();
    fd.append('name', $('#seg-name').value.trim());
    fd.append('start', JSON.stringify(state.segPoints[0]));
    fd.append('end', JSON.stringify(state.segPoints[1]));
    state.photos.forEach((p, i) => fd.append('photos', p.blob, p.name || `photo-${i}.jpg`));

    let segment = null;
    const landing = [];
    try {
      const r = await fetch('/api/segments?stream=1', { method: 'POST', body: fd });
      if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `${r.status}`); }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'photo') {
            const p = msg.photo; const shot = $$('#photo-strip .shot')[p.index];
            if (!shot) continue;
            shot.classList.remove('is-scanning');
            if (p.status === 'failed') { shot.classList.add('is-failed'); shot.insertAdjacentHTML('beforeend', `<span class="fail">Couldn't analyse: ${esc(p.error || 'unknown')}</span>`); }
            if (p.status === 'mock') shot.insertAdjacentHTML('beforeend', '<span class="badge mock">mock — no API key</span>');
            else if (p.cached) shot.insertAdjacentHTML('beforeend', '<span class="badge">cached</span>');
            landing.push(landBoxes(shot, p.hazards, { stagger: 150, onEach: () => { found++; ticker.textContent = found; ticker.classList.add('tick'); setTimeout(() => ticker.classList.remove('tick'), 200); } }));
          } else if (msg.type === 'segment') segment = msg.segment;
          else if (msg.type === 'error') throw new Error(msg.error);
        }
      }
      if (!segment) throw new Error('No result came back');
      await Promise.all(landing);
      state.lastSegmentId = segment.id;
      // the reveal
      $('#dial-cap').textContent = 'out of 100';
      const arc = $('#dial-arc');
      arc.style.stroke = M.scoreColor(segment.score);
      arc.style.transition = reduceMotion ? 'none' : 'stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1), stroke .3s';
      requestAnimationFrame(() => { arc.style.strokeDashoffset = 400 - (400 * segment.score) / 100; });
      await countUp($('#dial-num'), segment.score, { ms: 1100 });
      $('#result-verdicts').innerHTML = verdictsHtml(segment.verdicts);
      const byAuth = Object.entries(segment.cost_by_authority || {}).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
      $('#result-cost').innerHTML = `<div class="cost-total"><span>To fix this stretch</span><b>${fmtINR(segment.total_cost_inr)}</b></div><div class="cost-rows">${byAuth.map(([a, c]) => `<span>${esc(a)}</span><span>${fmtINR(c)}</span>`).join('') || '<span>No repair cost</span><span></span>'}</div>`;
      $('.result-actions').style.visibility = '';
      $('#contribute-form').hidden = true;
      $('#result-strip-slot').appendChild(strip); // photos with their boxes stay in view
      await loadSegments(); loadStats();
      toast(`Added "${segment.name}" to the map`, 'ok');
    } catch (err) {
      $$('#photo-strip .shot').forEach((s) => { s.classList.remove('is-scanning'); s.querySelector('.rm').hidden = false; });
      $('#result').hidden = true;
      const note = $('#analyse-note'); note.textContent = `Analysis failed: ${err.message}. Nothing was saved — try again.`; note.classList.add('is-error');
      toast(`Analysis failed: ${err.message}`, 'error');
    } finally {
      state.analysing = false; btn.classList.remove('is-busy');
      if (!$('#result').hidden) { /* keep disabled state until reset */ } else updateAnalyseState();
    }
  });

  // ?demo=1 preloads photos from /demo/manifest.json and the demo stretch
  async function maybeDemo() {
    const q = new URLSearchParams(location.search);
    if (q.get('demo') !== '1') return;
    try {
      const man = await api('/demo/manifest.json');
      setTab('contribute');
      if (man.start && man.end) M.setPicks([man.start, man.end]);
      if (man.name) { $('#seg-name').value = man.name; $('[data-step="name"]').classList.add('is-done'); }
      const files = [];
      for (const f of man.photos || []) {
        try { const b = await (await fetch(`/demo/${f}`)).blob(); files.push(new File([b], f, { type: b.type || 'image/jpeg' })); } catch { toast(`Demo photo ${f} missing`, 'error'); }
      }
      if (files.length) await addFiles(files);
      if (man.start) M.map.flyTo([man.start.lat, man.start.lng], 16);
      toast(`Demo loaded: ${files.length} photo${files.length === 1 ? '' : 's'} ready`, 'ok');
    } catch (err) { toast(`Demo mode: ${err.message}. Add public/demo/manifest.json`, 'error'); }
  }

  // ---------- route ----------
  const rptEls = { a: $('[data-rpt="a"]'), b: $('[data-rpt="b"]') };
  function onRoutePoints(points) {
    state.routePoints = points;
    ['a', 'b'].forEach((k, i) => { const p = points[i]; rptEls[k].textContent = p ? fmtLL(p) : (i ? 'to' : 'from'); rptEls[k].parentElement.classList.toggle('is-set', !!p); });
    $('#route-hint').textContent = points.length === 0 ? 'Tap the map for A, then B.' : points.length === 1 ? 'Now tap the destination.' : 'Drag the markers to adjust.';
    $('#btn-find-routes').disabled = points.length !== 2;
    $('#route-note').textContent = points.length === 2 ? `${(haversine(points[0], points[1]) / 1000).toFixed(1)} km apart as the crow flies` : 'Pick two points first.';
  }
  $('#btn-route-clear').addEventListener('click', () => { M.clearPicks(); onRoutePoints([]); M.clearRoutes(); $('#route-results').innerHTML = ''; state.routes = null; });
  $('#btn-route-demo').addEventListener('click', () => { M.setPicks([{ lat: 28.6672, lng: 77.2286 }, { lat: 28.6598, lng: 77.2288 }]); M.map.flyTo([28.6635, 77.2290], 15); });
  $$('.persona-opt').forEach((b) => b.addEventListener('click', () => {
    state.persona = b.dataset.persona;
    $$('.persona-opt').forEach((x) => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-checked', on); });
    if (state.routes && state.routePoints.length === 2) findRoutes();
  }));

  async function findRoutes() {
    if (state.routePoints.length !== 2) return;
    const btn = $('#btn-find-routes'); btn.disabled = true; btn.classList.add('is-busy');
    $('#route-note').textContent = 'Asking the routing server…';
    try {
      const data = await api('/api/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: state.routePoints[0], to: state.routePoints[1], persona: state.persona }) });
      state.routes = data;
      renderRoutes(data);
      $('#route-note').textContent = `${data.routes.length} route${data.routes.length === 1 ? '' : 's'} compared for a ${PERSONA_NAME[state.persona].toLowerCase()} ${state.persona === 'walk' ? 'person' : 'user'}.`;
    } catch (err) {
      $('#route-note').textContent = `Routing failed: ${err.message}`; $('#route-note').classList.add('is-error');
      toast(`Routing failed: ${err.message}`, 'error');
    } finally { btn.disabled = false; btn.classList.remove('is-busy'); }
  }
  $('#btn-find-routes').addEventListener('click', findRoutes);

  function renderRoutes(data) {
    const host = $('#route-results'); host.innerHTML = '';
    if (data.warning) host.insertAdjacentHTML('beforeend', `<div class="route-warn">${esc(data.warning)}</div>`);
    M.drawRoutes(data.routes, { recommended: data.recommended_index, onClick: (i) => activateRoute(i) });
    const order = data.routes.slice().sort((a, b) => (a.index === data.recommended_index ? -1 : b.index === data.recommended_index ? 1 : (b.score ?? -1) - (a.score ?? -1)));
    order.forEach((r, k) => {
      const covered = r.coverage >= 40 && r.score != null;
      const card = document.createElement('button');
      card.type = 'button'; card.className = `rc${r.index === data.recommended_index ? ' is-rec' : ''}`; card.dataset.index = r.index;
      card.innerHTML = `<div class="rc-score${covered ? '' : ' nodata'}" style="--c:${M.scoreColor(covered ? r.score : null)}">${covered ? r.score : 'no<br>data'}</div>
        <div>
          <div class="rc-head"><b>${data.routes.length === 1 ? 'Only route found' : r.index === data.recommended_index ? 'Recommended' : `Route ${r.index + 1}`}</b>${r.index === data.recommended_index && covered && data.routes.length > 1 ? '<span class="rc-rec">best with data</span>' : ''}</div>
          <div class="rc-meta">${(r.distance_m / 1000).toFixed(1)} km · ${r.duration_min} min · ${r.coverage}% of the way has been walked</div>
          <div class="rc-cov"><i style="--w:${r.coverage}%"></i></div>
          ${r.worst_hazard ? `<div class="rc-worst">Worst on the way: <b>${esc(r.worst_hazard.label_en || r.worst_hazard.type_id)}</b> (${r.worst_hazard.severity}/5) on ${esc(r.worst_hazard.segment_name)}</div>` : covered ? '<div class="rc-worst">No hazards recorded on the covered stretches</div>' : '<div class="rc-worst">Too little of this route has been walked to score it</div>'}
          ${r.persona_blockers.length ? `<div class="rc-block">Blocked for ${PERSONA_NAME[state.persona].toLowerCase()}: ${esc(r.persona_blockers[0].name)}${r.persona_blockers.length > 1 ? ` and ${r.persona_blockers.length - 1} more` : ''}</div>` : ''}
        </div>`;
      card.addEventListener('click', () => activateRoute(r.index));
      host.appendChild(card);
      setTimeout(() => card.classList.add('is-in'), reduceMotion ? 0 : 120 * k + 200);
    });
  }
  function activateRoute(i) {
    $$('.rc').forEach((c) => c.classList.toggle('is-active', Number(c.dataset.index) === i));
    M.highlightRoute(i);
  }

  // ---------- open data import ----------
  $('#btn-import').addEventListener('click', async () => {
    const btn = $('#btn-import');
    if (M.getZoom() < 13) { toast('Zoom in to a neighbourhood first, then import', 'error'); return; }
    btn.classList.add('is-busy'); btn.disabled = true; btn.querySelector('span').textContent = 'Asking OpenStreetMap…';
    try {
      const r = await api('/api/import/osm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(M.getBounds()) });
      await loadSegments(); loadStats();
      if (r.imported) toast(`Added ${r.imported} footpath${r.imported === 1 ? '' : 's'} graded from OpenStreetMap tags${r.already_known ? `, ${r.already_known} already here` : ''}`, 'ok');
      else if (r.already_known) toast(`All ${r.already_known} tagged footpaths in view were already imported`, 'ok');
      else toast('OpenStreetMap has no accessibility tags for footpaths in this view yet. Walk one to be the first.', '');
    } catch (err) { toast(err.message, 'error'); }
    finally { btn.classList.remove('is-busy'); btn.disabled = false; btn.querySelector('span').textContent = 'Add OpenStreetMap data for this area'; }
  });

  // ---------- map buttons ----------
  $('#btn-fit').addEventListener('click', M.fitAll);
  $('#btn-locate').addEventListener('click', async () => {
    const b = $('#btn-locate'); b.classList.add('is-busy');
    try {
      const p = await M.locate();
      if (state.tab === 'contribute' && state.segPoints.length === 0) { M.setPicks([p]); toast('Start set to your location. Tap where you stopped.', 'ok'); }
      else if (state.tab === 'route' && state.routePoints.length === 0) { M.setPicks([p]); toast('Starting from your location. Tap the destination.', 'ok'); }
    } catch (err) { toast(err.message, 'error'); } finally { b.classList.remove('is-busy'); }
  });

  // ---------- boot ----------
  (async function boot() {
    try {
      const health = await api('/api/health');
      if (health.mock) { const s = $('#ledger-status'); s.hidden = false; s.textContent = 'Mock vision — add ANTHROPIC_API_KEY to .env'; }
    } catch { toast('Server unreachable', 'error'); }
    try { const cfg = await api('/api/config'); if (cfg.google_maps_key) M.enableGoogle(cfg.google_maps_key); } catch {}
    try { state.standards = await api('/api/standards'); state.types = Object.fromEntries(state.standards.hazard_types.map((t) => [t.id, t])); } catch { toast('Knowledge file failed to load — hazard labels will be raw ids', 'error'); }
    const gj = await loadSegments();
    if (gj && gj.features.length) M.fitAll();
    else $('#segment-detail').innerHTML = `<div class="empty"><h2>Nothing mapped yet.</h2><p>Walk a footpath with the camera and it will appear here in colour.</p></div>`;
    loadStats();
    maybeDemo();
  })();
})();
