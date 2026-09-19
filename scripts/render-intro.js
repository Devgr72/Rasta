// node scripts/render-intro.js — renders the opening sequence to public/intro.mp4 (1920x1080, 30 fps)
// by seeking the page's CSS animations frame by frame in headless Chrome, then encoding with ffmpeg.
const puppeteer = require('puppeteer-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3000';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30, SECONDS = Number(process.env.SECONDS || 5.2);
const OUT = path.join(__dirname, '..', 'public', 'intro.mp4');
const FRAMES = fs.mkdtempSync('/tmp/rasta-intro-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await p.goto(`${BASE}/?intro=record`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#intro.play', { timeout: 20000 });
  await p.evaluate(() => window.__introSeek(0));
  // let the map behind the shutter finish painting before we start capturing
  await p.waitForFunction(() => document.querySelectorAll('.seg-line').length > 0, { timeout: 60000 }).catch(() => {});
  await sleep(12000);
  const total = Math.round(FPS * SECONDS);
  for (let f = 0; f < total; f++) {
    await p.evaluate((ms) => window.__introSeek(ms), (f / FPS) * 1000);
    await p.screenshot({ path: path.join(FRAMES, `f${String(f).padStart(4, '0')}.png`) });
    if (f % 30 === 0) process.stdout.write(`frame ${f}/${total}\n`);
  }
  await b.close();
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', OUT]);
  fs.rmSync(FRAMES, { recursive: true, force: true });
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
})().catch((e) => { console.error(e); process.exit(1); });
