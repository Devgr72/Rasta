#!/usr/bin/env node
// node scripts/test.js [filter] — runs every tests/*.test.js with the built-in node:test runner.
// Works the same in bash, PowerShell and cmd (no shell glob needed). Extra args go to `node --test`.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tests');
const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const passthrough = process.argv.slice(2).filter((a) => a.startsWith('--'));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!filter || f.includes(filter))).map((f) => path.join(dir, f));
if (!files.length) { console.error('no test files matched'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...passthrough, ...files], { stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' } });
process.exit(r.status ?? 1);
