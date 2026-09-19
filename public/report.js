/* report.js — fills the printable engineer's report from /api/segments/:id. External file so the CSP can stay script-src self. */
(async () => {
  const id = new URLSearchParams(location.search).get('id');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
  const page = document.getElementById('page');
  try {
    const [seg, std] = await Promise.all([fetch(`/api/segments/${id}`).then((r) => { if (!r.ok) throw new Error('segment not found'); return r.json(); }), fetch('/api/standards').then((r) => r.json())]);
    const types = Object.fromEntries(std.hazard_types.map((t) => [t.id, t]));
    const ref = `RST-${new Date(seg.created_at).getFullYear()}-${String(seg.id).padStart(4, '0')}`;
    const byAuth = {};
    for (const h of seg.hazards) byAuth[h.authority || 'Other'] = (byAuth[h.authority || 'Other'] || 0) + (h.cost_inr || 0);
    document.title = `${ref} — ${seg.name}`;
    page.innerHTML = `
      <div class="ref"><div>Path report · footpath condition<br>Crowdsourced field observation · Rasta</div><div style="text-align:right"><b>${ref}</b>${new Date(seg.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
      <h1>${esc(seg.name)}</h1>
      <p class="sub">From ${seg.start.lat.toFixed(5)}, ${seg.start.lng.toFixed(5)} to ${seg.end.lat.toFixed(5)}, ${seg.end.lng.toFixed(5)} · ${seg.length_m} m · surface: ${esc(seg.surface_type)}</p>
      <dl class="facts">
        <div><dt>Accessibility score</dt><dd>${seg.score}<span style="font-size:14px;color:var(--faint)"> / 100</span></dd></div>
        <div><dt>Hazards recorded</dt><dd>${seg.hazards.length}</dd></div>
        <div><dt>Minimum clear width</dt><dd>${seg.clear_width_m != null ? seg.clear_width_m.toFixed(1) + ' m' : '—'}</dd></div>
        <div><dt>Indicative repair cost</dt><dd>${inr(seg.total_cost_inr)}</dd></div>
      </dl>
      <h2>Who can use this footpath</h2>
      <ul class="verdicts">
        ${['walk', 'wheelchair', 'senior'].map((k) => `<li class="${seg.verdicts[k].ok ? 'pass' : 'fail'}"><b>${{ walk: 'Pedestrian', wheelchair: 'Wheelchair user', senior: 'Senior citizen' }[k]}</b> — ${esc(seg.verdicts[k].reason)}</li>`).join('')}
      </ul>
      <h2>Schedule of hazards</h2>
      <table><thead><tr><th>#</th><th>Hazard</th><th>Observation</th><th>Standard</th><th>Authority</th><th class="n">Severity</th><th class="n">Est. cost</th></tr></thead>
      <tbody>${seg.hazards.map((h, i) => `<tr><td>${i + 1}</td><td>${esc(types[h.type_id]?.label_en || h.type_id)}</td><td>${esc(h.note)}</td><td>${esc(types[h.type_id]?.standard_ref || '')}</td><td>${esc(h.authority || '')}</td><td class="n">${h.severity} / 5</td><td class="n">${h.cost_inr ? inr(h.cost_inr) : 'enforcement'}</td></tr>`).join('') || '<tr><td colspan="7">No hazards recorded.</td></tr>'}</tbody>
      <tfoot><tr><th colspan="6">Total indicative cost</th><th class="n">${inr(seg.total_cost_inr)}</th></tr></tfoot></table>
      <h2>Cost by responsible authority</h2>
      <table><tbody>${Object.entries(byAuth).map(([a, c]) => `<tr><td><b>${esc(a)}</b> — ${esc(std.authorities?.[a] || '')}</td><td class="n">${inr(c)}</td></tr>`).join('') || '<tr><td>None</td></tr>'}</tbody></table>
      ${seg.photos.some((p) => p.url) ? `<h2>Photographic evidence</h2><div class="photos">${seg.photos.filter((p) => p.url).map((p, i) => `<figure class="photo" style="margin:0"><div style="position:relative"><img src="${p.url}" alt="">${seg.hazards.filter((h) => h.photo_id === p.id && h.bbox).map((h) => `<div class="bx" style="left:${h.bbox.x * 100}%;top:${h.bbox.y * 100}%;width:${h.bbox.w * 100}%;height:${h.bbox.h * 100}%"><span>${esc(types[h.type_id]?.label_en || h.type_id)}</span></div>`).join('')}</div><figcaption>Photo ${i + 1}${p.observations ? ' — ' + esc(p.observations) : ''}</figcaption></figure>`).join('')}</div>` : ''}
      <h2>Where to file this report</h2>
      <table><tbody>${[...new Set(seg.hazards.map((h) => h.authority).filter(Boolean)), '_any'].map((a) => { const po = std.authority_portals?.[a]; if (!po) return ''; return `<tr><td><b>${a === '_any' ? 'Any department' : esc(a)}</b> — <a href="${esc(po.url)}" target="_blank" rel="noopener">${esc(po.label)}</a><br><span style="color:var(--faint)">${esc(po.how)}</span></td></tr>`; }).join('') || '<tr><td>No authority identified.</td></tr>'}</tbody></table>
      <p class="foot">Observations were recorded by a member of the public and graded automatically against the Harmonised Guidelines and Standards for Universal Accessibility in India (2021) and IRC:103-2012. Costs are indicative 2025 Delhi rates for scoping and are not an estimate for tender. Reference ${ref}.</p>`;
  } catch (err) { page.innerHTML = `<h1>Report unavailable</h1><p>${esc(err.message)}</p>`; }
})();
document.querySelector('.print').addEventListener('click', () => print());
