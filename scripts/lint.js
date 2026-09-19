#!/usr/bin/env node
// node scripts/lint.js — syntax-checks every .js file in the repo with `node --check`.
// No dependency; runs the same on Windows, macOS and Linux.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'uploads', 'data', '.code-review-graph']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    failed++;
    console.error(`✗ ${path.relative(ROOT, f)}\n${err.stderr ? err.stderr.toString() : err.message}`);
  }
}
console.log(`${files.length - failed}/${files.length} files pass node --check`);
process.exit(failed ? 1 : 0);
