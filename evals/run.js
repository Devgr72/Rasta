#!/usr/bin/env node
// node evals/run.js — scores vision output against evals/cases.json ground truth.
const path = require('path');
const fs = require('fs');
const { analysePhoto, MODEL, MOCK } = require('../vision');

(async () => {
  const cases = require('./cases.json').cases;
  const present = cases.filter((c) => fs.existsSync(path.join(__dirname, c.photo)));
  if (!present.length) {
    console.error(`No eval photos found. Add the files listed in evals/cases.json under evals/photos/ (${cases.length} expected).`);
    process.exit(1);
  }
  console.log(`model ${MODEL}${MOCK ? ' (MOCK)' : ''} · ${present.length}/${cases.length} photos present\n`);
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
    rows.push({ photo: path.basename(c.photo), hit: hit.length, miss: miss.join(',') || '-', fp: fp.join(',') || '-', ms: r.meta.latency_ms, err: r.meta.error || '' });
  }));
  rows.sort((a, b) => a.photo.localeCompare(b.photo));
  console.table(rows);
  console.log(`\n${hits} of ${expectedTotal} hazards found across ${present.length} photos · ${misses} missed · ${fps} false positive(s)`);
  const report = { model: MODEL, mock: MOCK, at: new Date().toISOString(), hits, expected: expectedTotal, misses, false_positives: fps, rows };
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(report, null, 2));
})();
