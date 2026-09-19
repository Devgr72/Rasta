#!/usr/bin/env node
// Usage: node test-vision.js <photo path> [--no-cache]
const fs = require('fs');
const path = require('path');
const { analysePhoto, MODEL, MOCK } = require('./vision');

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('usage: node test-vision.js <photo path> [--no-cache]');
    process.exit(1);
  }
  if (process.argv.includes('--no-cache')) {
    const { sha256 } = require('./vision');
    const p = path.join(__dirname, 'data', 'vision-cache', `${sha256(fs.readFileSync(file))}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log(`model: ${MODEL}${MOCK ? '  (MOCK MODE — no ANTHROPIC_API_KEY in .env)' : ''}`);
  const result = await analysePhoto(file);
  console.log(JSON.stringify(result, null, 2));
  if (result.meta.error) {
    console.error(`\nFAILED: ${result.meta.error}`);
    process.exit(2);
  }
  console.log(`\n${result.hazards.length} hazard(s), width ${result.estimated_clear_width_m ?? '?'} m, ${result.meta.latency_ms}ms${result.meta.cached ? ' (cached)' : ''}`);
})();
