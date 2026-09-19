#!/usr/bin/env node
// node evals/run.js — scores vision output against evals/cases.json ground truth.
// A missing photo is reported on its own row and skipped; it never aborts the run.
const path = require('path');
const fs = require('fs');
const { analysePhoto, MODEL, MOCK } = require('../vision');

async function main() {
  const cases = require('./cases.json').cases;
  const present = cases.filter((c) => fs.existsSync(path.join(__dirname, c.photo)));
  const missing = cases.filter((c) => !fs.existsSync(path.join(__dirname, c.photo)));
  console.log(`model ${MODEL}${MOCK ? ' (MOCK)' : ''} · ${present.length}/${cases.length} photos present\n`);
  if (!present.length) {
    console.warn(`No eval photos found. Add the files listed in evals/cases.json under evals/photos/ (${cases.length} expected). See README → Evals.`);
  }

  let hits = 0, misses = 0, fps = 0, expectedTotal = 0;
  const rows = [];
  await Promise.all(present.map(async (c) => {
    const r = await analysePhoto(path.join(__dirname, c.photo));
    const predicted = new Set(r.hazards.map((h) => h.type_id));
    const expected = new Set(c.expected);
    const hit = [...expected].filter((e) => predicted.has(e));
    const miss = [...expected].filter((e) => !predicted.has(e));
    const fp = [...predicted].filter((p) => !expected.has(p));
    hits += hit.length; misses += miss.length; fps += fp.length; expectedTotal += expected.size;
    rows.push({ photo: path.basename(c.photo), status: r.meta.error ? 'error' : 'ok', hit: hit.length, miss: miss.join(',') || '-', fp: fp.join(',') || '-', ms: r.meta.latency_ms, err: r.meta.error || '' });
  }));
  for (const c of missing) {
    rows.push({ photo: path.basename(c.photo), status: 'missing', hit: 0, miss: c.expected.join(',') || '-', fp: '-', ms: null, err: `file not found: evals/${c.photo}` });
  }
  rows.sort((a, b) => a.photo.localeCompare(b.photo));
  console.table(rows);
  console.log(`\n${hits} of ${expectedTotal} hazards found across ${present.length} photos · ${misses} missed · ${fps} false positive(s)${missing.length ? ` · ${missing.length} photo(s) missing` : ''}`);
  const report = { model: MODEL, mock: MOCK, at: new Date().toISOString(), photos_present: present.length, photos_missing: missing.length, hits, expected: expectedTotal, misses, false_positives: fps, rows };
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  main().catch((err) => { console.error('[eval] failed:', err.message); process.exit(1); });
}
module.exports = { main };
