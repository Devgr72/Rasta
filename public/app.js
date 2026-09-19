/* app.js — all frontend logic. Three tabs, show/hide only. */
(function () {
  const M = window.RastaMap;
  const I = window.RastaI18n;
  const t = (k, v) => I.t(k, v);
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

  // Hazard labels follow the UI language: Hindi first when the toggle is on, English as the secondary line.
  const typeLabel = (id) => (I.lang === 'hi' ? state.types[id]?.label_hi : state.types[id]?.label_en) || state.types[id]?.label_en || id.replace(/_/g, ' ');
  const typeLabelHi = (id) => (I.lang === 'hi' ? state.types[id]?.label_en : state.types[id]?.label_hi) || '';

  const PERSONA_ICON = {
    walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M11 8l-3 6 3 2 1 6M11 8l4 3 3-1M11 8l-4 4"/></svg>',
    wheelchair: '<svg viewBox="0 0 24 24"><circle cx="9" cy="19" r="4"/><circle cx="12" cy="4" r="2"/><path d="M12 7v6h6l3 6M9 15h5"/></svg>',
    senior: '<svg viewBox="0 0 24 24"><circle cx="12" cy="4" r="2"/><path d="M12 7v7l-3 8M12 14l3 8M12 9l5 2M7 22V11"/></svg>',
  };
  const PERSONA_NAME = { get walk() { return t('persona.walk'); }, get wheelchair() { return t('persona.wheelchair'); }, get senior() { return t('persona.senior'); } };

  function verdictsHtml(verdicts) {
    return ['walk', 'wheelchair', 'senior'].map((k) => {
      const v = verdicts[k];
      return `<li class="${v.ok ? 'pass' : 'fail'}">${PERSONA_ICON[k]}<b>${PERSONA_NAME[k]}<small>${v.ok ? t('verdict.pass') : t('verdict.fail')}</small></b><span>${esc(v.reason)}</span></li>`;
    }).join('');
  }

  // ---------- language ----------
  $('#btn-lang').addEventListener('click', () => I.setLang(I.lang === 'hi' ? 'en' : 'hi'));
  I.onChange(() => {
    if (state.tab === 'map' && !$('#segment-detail .seg')) showEmpty();
    onSegPoints(state.segPoints); onRoutePoints(state.routePoints); updateAnalyseState(); updateGpsPlacer(); updateLensNote(); updateQueueBadge();
    if (state.routes && state.tab === 'route') renderRoutes(state.routes);
  });
  I.apply();

  // ---------- keyboard: arrow keys move through tabs and radio groups (roving tabindex) ----------
  function rovingKeys(container, selector, activate) {
    container.addEventListener('keydown', (e) => {
      const items = $$(selector, container);
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % items.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = items.length - 1;
      if (n == null) return;
      e.preventDefault();
      items.forEach((el, k) => el.setAttribute('tabindex', k === n ? '0' : '-1'));
      items[n].focus();
      activate(items[n]);
    });
  }
  rovingKeys($('.tabs'), '.tab', (el) => setTab(el.dataset.tab));
  rovingKeys($('.lens'), '.lens-opt', (el) => el.click());
  rovingKeys($('.persona'), '.persona-opt', (el) => el.click());

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
    $$('.tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on); b.setAttribute('tabindex', on ? '0' : '-1'); });
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
    } catch (err) { toast(t('toast.stats', { err: err.message }), 'error'); }
  }
  function updateLensNote() {
    const el = $('#lens-note'); const s = state.stats; if (!s) return;
    const total = s.segments + (s.open_data_segments || 0);
    if (state.lens === 'score') el.innerHTML = t('lens.note.score', { avg: s.avg_score });
    else if (state.lens === 'wheelchair') el.innerHTML = t('lens.note.wheelchair', { ok: s.wheelchair_ok_count, n: total });
    else if (state.lens === 'senior') el.innerHTML = t('lens.note.senior', { ok: s.senior_ok_count, n: total });
    else { const ok = M.getFeatures().filter((f) => f.properties.verdicts.walk.ok).length; el.innerHTML = t('lens.note.walk', { ok, n: total }); }
  }
  $$('.lens-opt').forEach((b) => b.addEventListener('click', () => {
    state.lens = b.dataset.lens;
    $$('.lens-opt').forEach((x) => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-checked', on); x.setAttribute('tabindex', on ? '0' : '-1'); });
    M.setLens(state.lens); updateLensNote();
    $('#legend').hidden = state.lens !== 'score';
  }));

  async function loadSegments() {
    try {
      const gj = await api('/api/segments');
      M.renderSegments(gj);
      return gj;
    } catch (err) { toast(t('toast.segments', { err: err.message }), 'error'); return null; }
  }

  // ---------- segment detail ----------
  M.setOnSelect(async (id) => {
    if (state.tab !== 'map') return;
    const host = $('#segment-detail');
    host.innerHTML = `<div class="empty"><p>${t('seg.loading')}</p></div>`;
    if (isPhone()) setSheet(true);
    try {
      const seg = await api(`/api/segments/${id}`);
      renderSegment(seg, host);
    } catch (err) {
      host.innerHTML = `<div class="empty"><h2>${t('seg.failed')}</h2><p>${esc(err.message)}</p></div>`;
    }
  });
  window.addEventListener('rasta:mapclick', () => { if (state.tab === 'map') showEmpty(); });
  window.addEventListener('rasta:hazard-pin', (e) => {
    const row = $(`.hz[data-hazard-id="${e.detail.id}"]`); if (!row) return;
    if (isPhone()) setSheet(true);
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('is-flash'); setTimeout(() => row.classList.remove('is-flash'), 1400);
  });
  window.addEventListener('rasta:intro-done', () => setTimeout(M.invalidate, 50));

  function showEmpty() {
    M.clearHazardPins();
    $('#segment-detail').innerHTML = `<div class="empty"><h2>${t('empty.title')}</h2><p>${t('empty.body')}</p><p class="hint">${t('empty.hint')}</p></div>`;
  }

  const portalFor = (auth) => state.standards?.authority_portals?.[auth] || null;

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
    el('meta').textContent = t('seg.meta', {
      m: seg.length_m,
      hazards: seg.hazards.length === 1 ? t('seg.hazard.one') : t('seg.hazard.many', { n: seg.hazards.length }),
      photos: nPhotos ? (nPhotos === 1 ? t('seg.photo.one') : t('seg.photo.many', { n: nPhotos })) : seg.source === 'osm' ? t('seg.fromtags') : t('seg.photo.none'),
      width: seg.clear_width_m != null ? t('seg.width', { w: seg.clear_width_m.toFixed(1) }) : '',
    });
    I.apply(tpl);
    el('verdicts').innerHTML = verdictsHtml(seg.verdicts);
    el('close').addEventListener('click', () => { M.clearSelection(); showEmpty(); if (isPhone()) setSheet(false); });
    el('report').href = `/report.html?id=${seg.id}`;
    el('walk').addEventListener('click', () => {
      const pts = [seg.start, seg.end];
      setTab('contribute'); M.setPicks(pts); $('#seg-name').value = seg.name.replace(/ \((footway|footpath|road|steps)\)$/, '');
      $('[data-step="name"]').classList.add('is-done'); M.flyToSegment(seg.id);
      toast(t('seg.walk.set'), 'ok');
    });
    if (seg.source === 'commons' || seg.source === 'mapillary') {
      const src = el('source'); src.hidden = false;
      src.innerHTML = t('seg.source.open', { site: seg.source === 'mapillary' ? 'Mapillary' : 'Wikimedia Commons' });
    }
    if (seg.source === 'osm') {
      const src = el('source'); src.hidden = false;
      src.innerHTML = t('seg.source.osm', { url: `https://www.openstreetmap.org/way/${seg.osm_id}` });
      el('walk').textContent = t('seg.verify');
    }
    // other readings of the same stretch
    (async () => {
      try {
        const mid = { lat: (seg.start.lat + seg.end.lat) / 2, lng: (seg.start.lng + seg.end.lng) / 2 };
        const r = await api(`/api/segments/near?lat=${mid.lat}&lng=${mid.lng}&r=60`);
        const others = r.segments.filter((s) => s.id !== seg.id);
        if (!others.length) return;
        const also = host.querySelector('[data-el="also"]'); if (!also) return;
        also.innerHTML = `<h3>${t('seg.also')}</h3><ul>${others.slice(0, 5).map((s) => `<li><button type="button" data-view="${s.id}"><span class="sc" style="background:${M.scoreColor(s.score)}">${s.score}</span><span>${esc(s.name)}<br><small>${s.source === 'osm' ? t('seg.also.osm') : t('seg.also.walked', { date: new Date(s.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) })} · ${t('seg.also.away', { m: s.distance_m })}</small></span></button></li>`).join('')}</ul>`;
        $$('[data-view]', also).forEach((b) => b.addEventListener('click', () => { const id = Number(b.dataset.view); M.flyToSegment(id); M.select(id); }));
      } catch {}
    })();

    // photos with boxes
    const photos = el('photos');
    const shots = new Map();
    if (!seg.photos.some((p) => p.url)) {
      photos.innerHTML = `<div class="shot none">${seg.source === 'osm' ? t('seg.nophotos.osm') : t('seg.nophotos')}</div>`;
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
    if (!seg.hazards.length) hz.innerHTML = `<p class="analyse-note" style="text-align:left">${t('seg.nohazards')}</p>`;
    const perPhoto = {};
    for (const h of seg.hazards) { if (h.bbox) (perPhoto[h.photo_id] ||= []).push(h); }
    for (const h of seg.hazards) {
      const row = document.createElement('div');
      row.className = 'hz'; row.tabIndex = 0; row.setAttribute('role', 'group'); row.setAttribute('aria-label', `${typeLabel(h.type_id)}, ${h.severity}/5`);
      const group = perPhoto[h.photo_id] || [];
      const chip = group.length > 3 ? `<small class="hz-n">${group.indexOf(h) + 1}</small>` : '';
      row.innerHTML = `<span class="hz-sev ${h.severity >= 4 ? 'hi' : h.severity <= 2 ? 'lo' : ''}" aria-hidden="true">${h.severity}${chip}</span>
        <div><b>${esc(typeLabel(h.type_id))}<span class="hi-label">${esc(typeLabelHi(h.type_id))}</span></b><p>${esc(h.note || '')}</p><div class="auth">${esc(h.authority || '')} · ${esc(state.types[h.type_id]?.standard_ref || '')}</div><div class="hz-actions"><button type="button" class="hz-copy">${t('hz.copy')}</button>${portalFor(h.authority) ? `<a class="hz-submit" href="${esc(portalFor(h.authority).url)}" target="_blank" rel="noopener" title="${esc(portalFor(h.authority).how || '')}">${t('hz.submit', { auth: h.authority })}</a>` : ''}<a class="hz-submit" href="${esc(portalFor('_any')?.url || 'https://pgms.delhi.gov.in/')}" target="_blank" rel="noopener">${t('hz.submit.any')}</a></div></div>
        <span class="hz-cost">${h.cost_inr ? fmtINR(h.cost_inr) : t('hz.enforce')}</span>`;
      row.dataset.hazardId = h.id;
      const hot = (on) => { row.classList.toggle('is-hot', on); M.hotPin(h.id, on); const shot = shots.get(h.photo_id); shot?.querySelectorAll('.box').forEach((b) => { b.style.opacity = on ? (b.dataset.hazard == h.id ? 1 : .15) : ''; }); };
      row.addEventListener('mouseenter', () => hot(true)); row.addEventListener('mouseleave', () => hot(false));
      row.addEventListener('focus', () => hot(true)); row.addEventListener('blur', () => hot(false));
      row.querySelector('.hz-copy').addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(complaintText(seg, h)); toast(t('hz.copied', { auth: h.authority || t('hz.authority') }), 'ok'); }
        catch { toast(t('hz.clipboard'), 'error'); }
      });
      hz.appendChild(row);
    }

    // cost
    const byAuth = {};
    for (const h of seg.hazards) if (h.cost_inr) byAuth[h.authority || 'Other'] = (byAuth[h.authority || 'Other'] || 0) + h.cost_inr;
    el('cost').innerHTML = `<div class="cost-total"><span>${t('cost.total')}</span><b>${fmtINR(seg.total_cost_inr)}</b></div>
      <div class="cost-rows">${Object.entries(byAuth).sort((a, b) => b[1] - a[1]).map(([a, c]) => `<span>${esc(a)}<br><small style="color:var(--ink-faint)">${esc(state.standards?.authorities?.[a] || '')}</small></span><span>${fmtINR(c)}</span>`).join('') || `<span>${t('cost.none')}</span><span></span>`}</div>`;

    if (seg.hazards.length) hz.insertAdjacentHTML('afterbegin', `<p class="pins-note">${t('seg.pins')}</p>`);
    host.innerHTML = ''; host.appendChild(tpl);
    M.showHazardPins(seg);
    // land boxes after paint
    requestAnimationFrame(() => {
      for (const [pid, shot] of shots) landBoxes(shot, seg.hazards.filter((h) => h.photo_id === pid), { stagger: 150 });
    });
  }

  // ---------- contribute ----------
  const ptEls = { a: $('[data-pt="a"]'), b: $('[data-pt="b"]') };
  function onSegPoints(points) {
    state.segPoints = points;
    ['a', 'b'].forEach((k, i) => { const p = points[i]; ptEls[k].textContent = p ? fmtLL(p) : (i ? t('c.end') : t('c.start')); ptEls[k].parentElement.classList.toggle('is-set', !!p); });
    $('#points-len').innerHTML = points.length === 2 ? t('c.len', { m: Math.round(haversine(points[0], points[1])) }) : '';
    $('#points-hint').textContent = points.length === 0 ? t('c.hint0') : points.length === 1 ? t('c.hint1') : t('c.hint2');
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
    $('#analyse-count').textContent = state.photos.length ? (state.photos.length === 1 ? t('c.count.one') : t('c.count.many', { n: state.photos.length })) : '';
    const note = $('#analyse-note');
    note.classList.remove('is-error');
    if (state.analysing) note.textContent = t('c.note.analysing');
    else if (state.segPoints.length < 2 && !state.photos.length) note.textContent = t('c.note.both');
    else if (state.segPoints.length < 2) note.textContent = t('c.note.points');
    else if (!state.photos.length) note.textContent = t('c.note.photos');
    else note.textContent = t('c.note.ready');
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

  // Read GPS and capture time from the original file *before* shrinking (the canvas re-encode
  // drops EXIF). Sent to the server as photo_meta so the location survives the resize.
  async function photoMeta(file) {
    const meta = {};
    if (!window.exifr) return meta;
    try {
      const g = await exifr.gps(file);
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) && (g.latitude !== 0 || g.longitude !== 0)) { meta.lat = g.latitude; meta.lng = g.longitude; }
    } catch { /* no GPS */ }
    try {
      const x = await exifr.parse(file, { pick: ['DateTimeOriginal'], reviveValues: false });
      const s = x && x.DateTimeOriginal;
      const m = typeof s === 'string' ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s) : null;
      if (m) meta.taken_at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`; // camera wall-clock, no zone invented
    } catch { /* no time */ }
    return meta;
  }

  function updateGpsPlacer() {
    const n = state.photos.filter((p) => p.meta && p.meta.lat != null).length;
    const b = $('#btn-place-gps');
    b.hidden = n === 0;
    b.textContent = n === 1 ? t('c.gps.one') : t('c.gps.many', { n });
  }

  async function addFiles(files) {
    const room = 12 - state.photos.length;
    const list = [...files].filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name)).slice(0, room);
    if ([...files].length > room) toast(`Only ${room} more photo${room === 1 ? '' : 's'} fit (12 max)`, 'error');
    for (const f of list) {
      const [meta, blob] = await Promise.all([photoMeta(f), shrink(f)]);
      const url = URL.createObjectURL(blob);
      const id = Math.random().toString(36).slice(2);
      state.photos.push({ id, blob, url, name: f.name, meta });
      const shot = document.createElement('div');
      shot.className = 'shot'; shot.dataset.id = id;
      shot.innerHTML = `<img src="${url}" alt=""><button type="button" class="rm" aria-label="Remove photo">×</button><i class="scan"></i>${meta.lat != null ? '<span class="badge" title="This photo carries a GPS position">GPS</span>' : ''}`;
      shot.querySelector('.rm').addEventListener('click', () => { state.photos = state.photos.filter((p) => p.id !== id); shot.remove(); URL.revokeObjectURL(url); updateAnalyseState(); updateGpsPlacer(); });
      $('#photo-strip').appendChild(shot);
    }
    updateAnalyseState();
    updateGpsPlacer();
  }

  // Auto-place the stretch from the first and last geotagged photo. Two map taps remain the fallback.
  $('#btn-place-gps').addEventListener('click', () => {
    const withGps = state.photos.filter((p) => p.meta && p.meta.lat != null);
    if (!withGps.length) return;
    const sorted = withGps.every((p) => p.meta.taken_at) ? withGps.slice().sort((a, b) => a.meta.taken_at.localeCompare(b.meta.taken_at)) : withGps;
    const a = sorted[0].meta, b = sorted[sorted.length - 1].meta;
    const pts = [{ lat: a.lat, lng: a.lng }];
    if (sorted.length > 1 && haversine(a, b) > 5) pts.push({ lat: b.lat, lng: b.lng });
    M.setPicks(pts);
    M.map.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.6), { maxZoom: 17, duration: 0.8 });
    toast(pts.length === 2 ? t('c.gps.placed', { n: sorted.length }) : t('c.gps.start'), 'ok');
  });
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
    $('#btn-place-gps').hidden = true;
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
    $('#result-name').textContent = $('#seg-name').value.trim() || t('c.unnamed');
    $('#result-verdicts').innerHTML = ''; $('#result-cost').innerHTML = ''; $('.result-actions').style.visibility = 'hidden';
    $('#dial-num').textContent = '0'; $('#dial-num').dataset.v = 0; $('#dial-arc').style.strokeDashoffset = 400; $('#dial-cap').textContent = t('c.dial.analysing'); $('#sr-score').textContent = '';

    const fd = new FormData();
    fd.append('name', $('#seg-name').value.trim());
    fd.append('start', JSON.stringify(state.segPoints[0]));
    fd.append('end', JSON.stringify(state.segPoints[1]));
    state.photos.forEach((p, i) => fd.append('photos', p.blob, p.name || `photo-${i}.jpg`));
    fd.append('photo_meta', JSON.stringify(state.photos.map((p) => p.meta || {})));

    let segment = null;
    let budgetToasted = false;
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
          if (msg.type === 'queued') {
            // The service worker stored the request because we are offline. Nothing was analysed yet.
            $$('#photo-strip .shot').forEach((s) => { s.classList.remove('is-scanning'); s.classList.add('is-queued'); });
            $('#result').hidden = true; $('#contribute-form').hidden = false;
            toast(t('c.queued'), 'ok');
            updateQueueBadge();
            resetContribute();
            return;
          }
          if (msg.type === 'photo') {
            const p = msg.photo; const shot = $$('#photo-strip .shot')[p.index];
            if (!shot) continue;
            shot.classList.remove('is-scanning');
            if (p.status === 'failed') {
              shot.classList.add('is-failed'); shot.insertAdjacentHTML('beforeend', `<span class="fail">${esc(t('c.failed.photo', { err: p.error || 'unknown' }))}</span>`);
              if (/daily budget/i.test(p.error || '') && !budgetToasted) { budgetToasted = true; toast(t('c.budget'), 'error'); }
            }
            if (p.status === 'mock') shot.insertAdjacentHTML('beforeend', `<span class="badge mock">${t('c.mock')}</span>`);
            else if (p.cached) shot.insertAdjacentHTML('beforeend', `<span class="badge">${t('c.cached')}</span>`);
            landing.push(landBoxes(shot, p.hazards, { stagger: 150, onEach: () => { found++; ticker.textContent = found; ticker.classList.add('tick'); setTimeout(() => ticker.classList.remove('tick'), 200); } }));
          } else if (msg.type === 'segment') segment = msg.segment;
          else if (msg.type === 'error') throw new Error(msg.error);
        }
      }
      if (!segment) throw new Error(t('c.noresult'));
      await Promise.all(landing);
      state.lastSegmentId = segment.id;
      // the reveal
      $('#dial-cap').textContent = t('c.dial.cap');
      $('#sr-score').textContent = t('sr.score', { score: segment.score, hazards: segment.hazards.length });
      const arc = $('#dial-arc');
      arc.style.stroke = M.scoreColor(segment.score);
      arc.style.transition = reduceMotion ? 'none' : 'stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1), stroke .3s';
      requestAnimationFrame(() => { arc.style.strokeDashoffset = 400 - (400 * segment.score) / 100; });
      await countUp($('#dial-num'), segment.score, { ms: 1100 });
      $('#result-verdicts').innerHTML = verdictsHtml(segment.verdicts);
      const byAuth = Object.entries(segment.cost_by_authority || {}).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
      $('#result-cost').innerHTML = `<div class="cost-total"><span>${t('cost.total')}</span><b>${fmtINR(segment.total_cost_inr)}</b></div><div class="cost-rows">${byAuth.map(([a, c]) => `<span>${esc(a)}</span><span>${fmtINR(c)}</span>`).join('') || `<span>${t('cost.none.short')}</span><span></span>`}</div>`;
      $('.result-actions').style.visibility = '';
      $('#contribute-form').hidden = true;
      $('#result-strip-slot').appendChild(strip); // photos with their boxes stay in view
      await loadSegments(); loadStats();
      toast(t('c.added', { name: segment.name }), 'ok');
    } catch (err) {
      if (state.analysing === false) return; // already handled (queued offline)
      $$('#photo-strip .shot').forEach((s) => { s.classList.remove('is-scanning'); s.querySelector('.rm').hidden = false; });
      $('#result').hidden = true;
      const note = $('#analyse-note'); note.textContent = t('c.failed.note', { err: err.message }); note.classList.add('is-error');
      toast(t('c.failed', { err: err.message }), 'error');
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
  // A and B can be typed as place names (geocoded on Search/Enter) or tapped on the map. Names for
  // tapped points come from a reverse lookup so the inputs always read like a journey, not coordinates.
  const geoInputs = { a: $('#geo-a'), b: $('#geo-b') };
  state.routeNames = { a: null, b: null }; // { name, lat, lng } for each end
  state.pendingB = null;                    // B chosen before A exists
  const sameSpot = (n, p) => n && p && haversine(n, p) < 5;
  const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

  function onRoutePoints(points) {
    const key = JSON.stringify(points.map((p) => [p.lat.toFixed(6), p.lng.toFixed(6)]));
    const changed = key !== state.routeKey; state.routeKey = key;
    state.routePoints = points;
    if (points.length === 1 && state.pendingB) { const b = state.pendingB; state.pendingB = null; M.setPicks([points[0], { lat: b.lat, lng: b.lng }]); return; }
    ['a', 'b'].forEach((k, i) => {
      const p = points[i]; const inp = geoInputs[k]; const row = inp.closest('.geo-row');
      row.classList.toggle('is-set', !!p);
      if (!p) { if (!(k === 'b' && state.pendingB)) { inp.value = ''; state.routeNames[k] = null; } return; }
      if (sameSpot(state.routeNames[k], p)) { inp.value = state.routeNames[k].name; return; }
      state.routeNames[k] = null; inp.value = fmtLL(p);
      reverseName(k, p);
    });
    $$('.geo-results').forEach((el) => { el.hidden = true; });
    $('#route-hint').textContent = points.length === 0 ? t('r.hint0') : points.length === 1 ? (state.pendingB ? t('r.setA') : t('r.hint1')) : t('r.hint2');
    $('#btn-find-routes').disabled = points.length !== 2;
    $('#route-note').textContent = points.length === 2 ? t('r.note.apart', { km: (haversine(points[0], points[1]) / 1000).toFixed(1) }) : t('r.note.pick');
    $('#route-note').classList.remove('is-error');
    if (changed) { // moving A or B invalidates the comparison; a language switch or tab change does not
      stopWalking();
      if (state.routes) { M.clearRoutes(); $('#route-results').innerHTML = ''; state.routes = null; }
    }
  }
  const reverseTimers = {};
  function reverseName(k, p) {
    clearTimeout(reverseTimers[k]);
    reverseTimers[k] = setTimeout(async () => {
      try {
        const r = await api(`/api/geocode/reverse?lat=${p.lat}&lng=${p.lng}&lang=${I.lang}`);
        const cur = state.routePoints[k === 'a' ? 0 : 1];
        if (r.place && cur && sameSpot(cur, p)) { state.routeNames[k] = { name: r.place.name, lat: p.lat, lng: p.lng }; geoInputs[k].value = r.place.name; }
      } catch { /* coordinates stay */ }
    }, 350);
  }
  async function searchPlace(k) {
    const inp = geoInputs[k]; const q = inp.value.trim(); const box = $(`#geo-results-${k}`); const btn = $(`[data-geo-go="${k}"]`);
    if (q.length < 2 || (state.routeNames[k] && state.routeNames[k].name === q)) return;
    btn.classList.add('is-busy'); btn.disabled = true; box.hidden = false; box.innerHTML = `<div class="geo-empty">${t('r.searching')}</div>`;
    try {
      const c = M.map.getCenter();
      const r = await api(`/api/geocode?q=${encodeURIComponent(q)}&lat=${c.lat}&lng=${c.lng}&lang=${I.lang}`);
      if (!r.results.length) { box.innerHTML = `<div class="geo-empty">${esc(t('r.noresults', { q }))}</div>`; return; }
      box.innerHTML = r.results.map((p, i) => `<button type="button" role="option" data-pick="${i}">${esc(p.name)}<small>${esc(p.display_name)}</small></button>`).join('');
      $$('[data-pick]', box).forEach((b) => b.addEventListener('click', () => pickPlace(k, r.results[Number(b.dataset.pick)])));
      if (r.results.length === 1) pickPlace(k, r.results[0]);
    } catch (err) { box.innerHTML = `<div class="geo-empty">${esc(t('r.geo.failed', { err: err.message }))}</div>`; }
    finally { btn.classList.remove('is-busy'); btn.disabled = false; }
  }
  function pickPlace(k, place) {
    const P = { lat: place.lat, lng: place.lng };
    state.routeNames[k] = { name: place.name, lat: P.lat, lng: P.lng };
    geoInputs[k].value = place.name;
    $(`#geo-results-${k}`).hidden = true;
    const pts = state.routePoints.slice();
    if (k === 'a') { pts[0] = P; if (state.pendingB) { pts[1] = { lat: state.pendingB.lat, lng: state.pendingB.lng }; state.pendingB = null; } }
    else if (pts.length === 0) { state.pendingB = { ...P, name: place.name }; geoInputs.b.closest('.geo-row').classList.add('is-set'); $('#route-hint').textContent = t('r.setA'); M.map.flyTo([P.lat, P.lng], 15); return; }
    else pts[1] = P;
    M.setPicks(pts);
    if (pts.length === 2) M.map.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.3), { duration: 0.8 });
    else M.map.flyTo([P.lat, P.lng], 15);
  }
  ['a', 'b'].forEach((k) => {
    geoInputs[k].addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchPlace(k); } if (e.key === 'Escape') $(`#geo-results-${k}`).hidden = true; });
    $(`[data-geo-go="${k}"]`).addEventListener('click', () => searchPlace(k));
  });
  $('#btn-route-swap').addEventListener('click', () => {
    const pts = state.routePoints.slice().reverse();
    const names = state.routeNames; state.routeNames = { a: names.b, b: names.a };
    if (pts.length === 2) M.setPicks(pts);
  });
  $('#btn-route-clear').addEventListener('click', () => { state.pendingB = null; state.routeNames = { a: null, b: null }; M.clearPicks(); onRoutePoints([]); M.clearRoutes(); $('#route-results').innerHTML = ''; state.routes = null; });
  $('#btn-route-demo').addEventListener('click', () => {
    state.routeNames = { a: { name: 'Kashmere Gate Metro, Gate 3', lat: 28.6672, lng: 77.2286 }, b: { name: 'Old Delhi Railway Station', lat: 28.6598, lng: 77.2288 } };
    M.setPicks([{ lat: 28.6672, lng: 77.2286 }, { lat: 28.6598, lng: 77.2288 }]); M.map.flyTo([28.6635, 77.2290], 15);
  });
  $$('.persona-opt').forEach((b) => b.addEventListener('click', () => {
    state.persona = b.dataset.persona;
    $$('.persona-opt').forEach((x) => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-checked', on); x.setAttribute('tabindex', on ? '0' : '-1'); });
    // times for every persona are already on each card: just re-render with the new highlight and best route
    if (state.routes) { state.routes.persona = state.persona; state.routes.recommended_index = state.routes.best_for ? state.routes.best_for[state.persona] : state.routes.recommended_index; renderRoutes(state.routes); }
  }));

  async function findRoutes() {
    if (state.routePoints.length !== 2) return;
    const btn = $('#btn-find-routes'); btn.disabled = true; btn.classList.add('is-busy');
    $('#route-note').textContent = t('r.note.asking'); $('#route-note').classList.remove('is-error');
    try {
      const data = await api('/api/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: state.routePoints[0], to: state.routePoints[1], persona: state.persona }) });
      state.routes = data;
      renderRoutes(data);
      $('#route-note').textContent = t('r.note.done', { n: data.routes.length, persona: t(`r.persona.${state.persona}`) });
    } catch (err) {
      $('#route-note').textContent = t('r.failed', { err: err.message }); $('#route-note').classList.add('is-error');
      toast(t('r.failed', { err: err.message }), 'error');
    } finally { btn.disabled = false; btn.classList.remove('is-busy'); }
  }
  $('#btn-find-routes').addEventListener('click', findRoutes);

  const PERSONAS = ['walk', 'wheelchair', 'senior'];
  function renderRoutes(data) {
    stopWalking();
    const host = $('#route-results'); host.innerHTML = '';
    if (data.warning) host.insertAdjacentHTML('beforeend', `<div class="route-warn">${esc(data.warning)}</div>`);
    M.drawRoutes(data.routes, { recommended: data.recommended_index, onClick: (i) => activateRoute(i) });
    const best = data.best_for || {};
    const order = data.routes.slice().sort((a, b) => (a.index === data.recommended_index ? -1 : b.index === data.recommended_index ? 1 : (b.score ?? -1) - (a.score ?? -1)));
    order.forEach((r, k) => {
      const covered = r.coverage >= 40 && r.score != null;
      const times = r.times || {}; const passable = r.passable || {};
      const card = document.createElement('div');
      card.className = `rc${r.index === data.recommended_index ? ' is-rec' : ''}`; card.dataset.index = r.index; card.tabIndex = 0; card.setAttribute('role', 'button');
      const timesHtml = PERSONAS.map((p) => `<span class="rt${p === state.persona ? ' is-me' : ''}${passable[p] === false ? ' is-blocked' : ''}" title="${esc(t(`r.persona.${p}`))}">${PERSONA_ICON[p]}${passable[p] === false ? t('r.blocked.short') : t('r.min', { n: times[p] ?? r.duration_min })}${best[p] === r.index && data.routes.length > 1 ? '<i class="star" aria-hidden="true">★</i>' : ''}</span>`).join('');
      const problems = r.problems || [];
      const problemsHtml = problems.length
        ? `<details class="rc-problems"><summary>${r.problem_count === 1 ? t('r.problem') : t('r.problems', { n: r.problem_count })}</summary><ol>${problems.map((h, j) => `<li><button type="button" data-prob="${j}"><span class="pn sev-${h.severity}">${j + 1}</span><span><b>${esc(typeLabel(h.type_id) || h.label_en)}</b> · ${h.severity}/5<br><small>${esc(h.segment_name)}${h.note ? ' — ' + esc(h.note) : ''}</small></span></button></li>`).join('')}</ol></details>`
        : covered ? `<div class="rc-problems"><span class="none">${t('r.noproblems')}</span></div>` : '';
      card.innerHTML = `<div class="rc-score${covered ? '' : ' nodata'}" style="--c:${M.scoreColor(covered ? r.score : null)}">${covered ? r.score : t('r.nodata')}</div>
        <div>
          <div class="rc-head"><b>${data.routes.length === 1 ? t('r.only') : r.index === data.recommended_index ? t('r.rec') : t('r.n', { n: r.index + 1 })}</b>${r.index === data.recommended_index && covered && data.routes.length > 1 ? `<span class="rc-rec">${esc(t('r.best.for', { persona: t(`r.persona.${state.persona}`) }))}</span>` : ''}</div>
          <div class="rc-meta">${t('r.meta', { km: (r.distance_m / 1000).toFixed(1), min: times[state.persona] ?? r.duration_min, cov: r.coverage })}</div>
          <div class="rc-times" title="${esc(t('r.times.title'))}">${timesHtml}</div>
          <div class="rc-cov" role="img" aria-label="${r.coverage}%"><i style="--w:${r.coverage}%"></i></div>
          ${r.worst_hazard ? `<div class="rc-worst">${t('r.worst', { label: esc(typeLabel(r.worst_hazard.type_id) || r.worst_hazard.label_en), sev: r.worst_hazard.severity, seg: esc(r.worst_hazard.segment_name) })}</div>` : covered ? `<div class="rc-worst">${t('r.clean')}</div>` : `<div class="rc-worst">${t('r.toolittle')}</div>`}
          ${(r.blockers && r.blockers[state.persona] || r.persona_blockers).length ? `<div class="rc-block">${t('r.blocked', { persona: t(`r.persona.${state.persona}`), seg: esc((r.blockers && r.blockers[state.persona] || r.persona_blockers)[0].name) })}${(r.blockers && r.blockers[state.persona] || r.persona_blockers).length > 1 ? t('r.more', { n: (r.blockers && r.blockers[state.persona] || r.persona_blockers).length - 1 }) : ''}</div>` : ''}
          ${problemsHtml}
          <div class="rc-actions"><button type="button" class="primary rc-start">${t('r.start')}</button></div>
          <div class="rc-walk"><div class="rc-progress"><i></i></div><div class="rc-walk-text"></div><div class="rc-next"></div><button type="button" class="ghost rc-stop">${t('r.stop')}</button></div>
        </div>`;
      const activate = () => activateRoute(r.index);
      card.addEventListener('click', (e) => { if (e.target.closest('button, summary, details')) return; activate(); });
      card.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); activate(); } });
      $$('[data-prob]', card).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); activateRoute(r.index); const j = Number(b.dataset.prob); M.highlightRouteHazard(j, true); $$('[data-prob]', card).forEach((x) => x.classList.toggle('is-hot', x === b)); }));
      card.querySelector('.rc-start').addEventListener('click', (e) => { e.stopPropagation(); activateRoute(r.index); startWalking(r, card); });
      card.querySelector('.rc-stop').addEventListener('click', (e) => { e.stopPropagation(); stopWalking(); });
      host.appendChild(card);
      setTimeout(() => card.classList.add('is-in'), reduceMotion ? 0 : 120 * k + 200);
    });
    if (data.recommended_index != null) activateRoute(data.recommended_index, { quiet: true });
  }
  function activateRoute(i, { quiet } = {}) {
    if (M.isWalking() && state.walkingIndex !== i) stopWalking();
    $$('.rc').forEach((c) => c.classList.toggle('is-active', Number(c.dataset.index) === i));
    M.highlightRoute(i);
    const r = state.routes && state.routes.routes.find((x) => x.index === i);
    M.drawRouteHazards(r ? r.problems : [], { onClick: (j) => { const card = $(`.rc[data-index="${i}"]`); const btn = card && $$('[data-prob]', card)[j]; if (btn) { card.querySelector('.rc-problems')?.setAttribute('open', ''); btn.click(); btn.scrollIntoView({ block: 'nearest' }); } } });
    if (!quiet && isPhone()) setSheet(false);
  }

  // "Start walking": zoom to A and follow the route at the chosen persona's pace, calling out problems.
  function startWalking(r, card) {
    const speed = (state.routes && state.routes.speeds_mps && state.routes.speeds_mps[state.persona]) || 1.35;
    const problems = r.problems || [];
    const text = card.querySelector('.rc-walk-text'); const next = card.querySelector('.rc-next'); const bar = card.querySelector('.rc-progress i');
    state.walkingIndex = r.index;
    card.classList.add('is-walking');
    if (isPhone()) setSheet(false);
    const nextProblem = (pos) => {
      let bestP = null, bestD = Infinity;
      for (const [j, p] of problems.entries()) { if (seen.has(j) || p.lat == null) continue; const d = haversine(pos, p); if (d < bestD) { bestD = d; bestP = p; } }
      return bestP ? { p: bestP, d: bestD } : null;
    };
    const seen = new Set();
    const w = M.walkAlong(r.geometry.coordinates, {
      speedMps: speed, problems,
      onProgress: ({ done_m, total_m, fraction, remaining_s }) => {
        bar.style.setProperty('--w', `${Math.round(fraction * 100)}%`);
        text.innerHTML = t('r.walk.progress', { done: fmtDist(done_m), total: fmtDist(total_m), min: Math.max(1, Math.round(remaining_s / 60)), persona: t(`r.speed.${state.persona}`) });
        const coords = r.geometry.coordinates; const idx = Math.min(coords.length - 1, Math.floor(fraction * (coords.length - 1)));
        const n = nextProblem({ lng: coords[idx][0], lat: coords[idx][1] });
        next.className = `rc-next${n ? '' : ' none'}`;
        next.textContent = n ? t('r.next', { label: typeLabel(n.p.type_id) || n.p.label_en, m: Math.round(n.d / 10) * 10 }) : t('r.next.none');
      },
      onNear: (j, p) => { seen.add(j); M.highlightRouteHazard(j); toast(t('r.near', { label: typeLabel(p.type_id) || p.label_en, sev: p.severity, seg: p.segment_name }), p.severity >= 4 ? 'error' : ''); },
      onDone: ({ problems_seen }) => { toast(t('r.arrived', { n: problems_seen }), 'ok'); card.classList.remove('is-walking'); state.walkingIndex = null; M.highlightRouteHazard(-1); },
    });
    if (!w) card.classList.remove('is-walking');
  }
  function stopWalking() {
    M.stopWalk();
    $$('.rc.is-walking').forEach((c) => c.classList.remove('is-walking'));
    state.walkingIndex = null;
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
      if (state.tab === 'contribute' && state.segPoints.length === 0) { M.setPicks([p]); toast(t('toast.locate.start'), 'ok'); }
      else if (state.tab === 'route' && state.routePoints.length === 0) { M.setPicks([p]); toast(t('toast.locate.route'), 'ok'); }
    } catch (err) { toast(err.message, 'error'); } finally { b.classList.remove('is-busy'); }
  });

  // ---------- offline queue (service worker) ----------
  let queueCount = 0;
  function updateQueueBadge() {
    const b = $('#queue-badge');
    b.hidden = queueCount === 0;
    $('#queue-text').textContent = queueCount === 1 ? t('c.queue.badge.one') : t('c.queue.badge.many', { n: queueCount });
  }
  const swMessage = (msg) => navigator.serviceWorker?.controller?.postMessage(msg);
  $('#btn-queue-sync').addEventListener('click', () => swMessage({ type: 'rasta:replay' }));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (e) => {
      const m = e.data || {};
      if (m.type === 'rasta:queue') { queueCount = m.count || 0; updateQueueBadge(); }
      if (m.type === 'rasta:replayed') {
        if (m.ok) { toast(t('c.replayed', { name: m.name || m.segment?.name || '' }), 'ok'); await loadSegments(); loadStats(); }
        else toast(t('c.replay.failed', { err: m.error }), 'error');
      }
    });
    window.addEventListener('load', async () => {
      try {
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        swMessage({ type: 'rasta:queue-count' });
        if (navigator.onLine) swMessage({ type: 'rasta:replay' });
      } catch (err) { console.warn('service worker not registered', err.message); }
    });
  }
  window.addEventListener('online', () => { toast(t('toast.online'), 'ok'); swMessage({ type: 'rasta:replay' }); });
  window.addEventListener('offline', () => toast(t('toast.offline'), 'error'));

  // ---------- boot ----------
  (async function boot() {
    try {
      const health = await api('/api/health');
      if (health.mock) { const s = $('#ledger-status'); s.hidden = false; s.textContent = t('ledger.mock'); }
      else if (health.budget_reached) { const s = $('#ledger-status'); s.hidden = false; s.textContent = t('ledger.budget'); }
    } catch { toast(t('toast.server'), 'error'); }
    try { const cfg = await api('/api/config'); if (cfg.google_maps_key) M.enableGoogle(cfg.google_maps_key); } catch { /* optional */ }
    try { state.standards = await api('/api/standards'); state.types = Object.fromEntries(state.standards.hazard_types.map((x) => [x.id, x])); } catch { toast(t('toast.knowledge'), 'error'); }
    const gj = await loadSegments();
    if (gj && gj.features.length) M.fitAll();
    else $('#segment-detail').innerHTML = `<div class="empty"><h2>${t('empty.none.title')}</h2><p>${t('empty.none.body')}</p></div>`;
    loadStats();
    maybeDemo();
  })();
})();
