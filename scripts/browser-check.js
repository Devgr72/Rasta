#!/usr/bin/env node
// node scripts/browser-check.js — smoke-tests the running app in headless Chrome.
// Checks the three tabs, the segment panel and /report.html?id=1 render without page errors.
// Env: BASE (default http://localhost:3000), CHROME (browser binary), OUT (screenshot dir, optional).
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || '';
const CHROME = process.env.CHROME || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: '/usr/bin/google-chrome',
}[process.platform];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (OUT) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const results = [];
  const errors = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
  const shot = async (page, name) => { if (OUT) await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.setViewport({ width: 1440, height: 900 });

  // Map tab
  const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('index.html responds 200', resp && resp.status() === 200, String(resp && resp.status()));
  const segLines = await page.waitForFunction(() => window.RastaMap && document.querySelectorAll('.seg-line').length, { timeout: 20000 }).then((h) => h.jsonValue()).catch(() => 0);
  check('Map tab draws segments', segLines > 0, `${segLines} polylines`);
  const statsText = await page.$eval('[data-stat="segments"]', (el) => el.textContent).catch(() => '');
  await sleep(1200);
  const statsAfter = await page.$eval('[data-stat="segments"]', (el) => el.textContent).catch(() => '');
  check('Stats bar populated', Number(statsAfter) > 0, `segments=${statsAfter || statsText}`);
  await shot(page, '1-map');

  // Segment panel
  await page.evaluate(() => window.RastaMap.select(1, true));
  const panelOk = await page.waitForFunction(() => {
    const seg = document.querySelector('#segment-detail .seg');
    return seg && seg.querySelector('[data-el="name"]').textContent.length > 0 && seg.querySelectorAll('.verdicts li').length === 3;
  }, { timeout: 10000 }).then(() => true).catch(() => false);
  check('Segment panel renders name + 3 verdicts', panelOk);
  await sleep(600);
  await shot(page, '2-segment');

  // Contribute tab
  await page.click('[data-tab="contribute"]');
  await sleep(500);
  const contribOk = await page.evaluate(() => !document.getElementById('view-contribute').hidden && !!document.getElementById('contribute-form'));
  check('Contribute tab shows form', contribOk);
  await shot(page, '3-contribute');

  // Route tab
  await page.click('[data-tab="route"]');
  await sleep(500);
  const routeOk = await page.evaluate(() => !document.getElementById('view-route').hidden && !!document.getElementById('btn-find-routes'));
  check('Route tab shows controls', routeOk);
  await shot(page, '4-route');

  // Back to map, no errors
  await page.click('[data-tab="map"]');
  await sleep(300);

  // Report page
  const rp = await browser.newPage();
  rp.on('pageerror', (e) => errors.push(`report page: ${e.message}`));
  const rresp = await rp.goto(`${BASE}/report.html?id=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('report.html responds 200', rresp && rresp.status() === 200, String(rresp && rresp.status()));
  const reportOk = await rp.waitForFunction(() => {
    const h1 = document.querySelector('#page h1');
    return h1 && h1.textContent !== 'Report unavailable' && document.querySelectorAll('#page table').length >= 2 && document.querySelector('.ref b');
  }, { timeout: 10000 }).then(() => true).catch(() => false);
  const h1 = await rp.$eval('#page h1', (el) => el.textContent).catch(() => '');
  check('Report renders ref, title and tables', reportOk, h1);
  await shot(rp, '5-report');

  const realErrors = errors.filter((e) => !/tile\.openstreetmap|fonts\.g|net::ERR_|Failed to load resource/.test(e));
  check('No page/console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
