// node scripts/shoot.js — drives the UI in headless Chrome and screenshots every screen.
// Env: BASE (server), OUT (screenshot dir), CHROME (browser binary if not in the default place).
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || path.join(os.tmpdir(), 'shots');
const CHROME = process.env.CHROME || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: '/usr/bin/google-chrome',
}[process.platform];
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const errors = [];
  async function run(label, vp, steps) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
    await page.setViewport(vp);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.RastaMap && document.querySelectorAll('.seg-line').length > 0, { timeout: 20000 }).catch(() => {});
    await sleep(1500);
    await steps(page, async (name) => page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) }));
    await page.close();
  }
  const desktop = { width: 1440, height: 900 };
  const phone = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };

  const flows = async (page, shot) => {
    await shot('1-map');
    // select a segment via the map API
    await page.evaluate(() => window.RastaMap.select(1, true));
    await sleep(1800);
    await shot('2-segment');
    // lens
    await page.click('[data-lens="wheelchair"]'); await sleep(500); await shot('3-lens');
    // contribute
    await page.click('[data-tab="contribute"]'); await sleep(600);
    await page.evaluate(() => window.RastaMap.setPicks([{ lat: 28.6672, lng: 77.2286 }, { lat: 28.6640, lng: 77.2295 }]));
    await page.type('#seg-name', 'Test stretch by the metro');
    // synthesize 3 photos in-page and inject them
    await page.evaluate(async () => {
      const files = [];
      for (let i = 0; i < 3; i++) {
        const c = document.createElement('canvas'); c.width = 800; c.height = 600; const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, 0, 600); grd.addColorStop(0, '#6b7a8f'); grd.addColorStop(.55, '#8a8f96'); grd.addColorStop(1, '#4a4f57'); g.fillStyle = grd; g.fillRect(0, 0, 800, 600);
        g.fillStyle = '#9c8f7a'; for (let y = 330; y < 600; y += 40) for (let x = 0; x < 800; x += 60) { g.fillRect(x + (y % 80 ? 30 : 0), y, 56, 36); }
        g.fillStyle = `hsl(${i * 40},20%,30%)`; g.fillRect(100 + i * 150, 380, 220, 120);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', .9));
        files.push(new File([blob], `shot-${i}.jpg`, { type: 'image/jpeg' }));
      }
      const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
      const input = document.getElementById('photo-input'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(900);
    await shot('4-contribute');
    await page.click('#btn-analyse');
    await sleep(700); await shot('5-analysing');
    await page.waitForSelector('#contribute-form[hidden]', { timeout: 30000 });
    await sleep(1400); await shot('6-result');
    // route
    await page.click('[data-tab="route"]'); await sleep(500);
    await page.click('#btn-route-demo'); await sleep(900);
    await page.click('[data-persona="wheelchair"]');
    await page.click('#btn-find-routes');
    await page.waitForSelector('.rc', { timeout: 20000 }); await sleep(1600);
    await shot('7-route');
  };
  await run('desktop', desktop, flows);
  await run('phone', phone, async (page, shot) => {
    await shot('1-map');
    await page.evaluate(() => window.RastaMap.select(6, true)); await sleep(1500); await shot('2-segment');
    await page.click('[data-tab="contribute"]'); await sleep(600); await shot('3-contribute');
    await page.click('[data-tab="route"]'); await sleep(400); await page.click('#btn-route-demo'); await sleep(800); await page.click('#btn-find-routes');
    await page.waitForSelector('.rc', { timeout: 20000 }); await sleep(1500); await shot('4-route');
    // report debug: measure tab bar
    const m = await page.evaluate(() => { const n = document.querySelector('.tabs').getBoundingClientRect(); return { navW: n.width, tabs: [...document.querySelectorAll('.tab')].map((t) => Math.round(t.getBoundingClientRect().x)) }; });
    console.log('phone tabbar', JSON.stringify(m));
  });
  await browser.close();
  console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
})().catch((e) => { console.error(e); process.exit(1); });
