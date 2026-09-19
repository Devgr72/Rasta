/* sw.js — service worker: caches the app shell, keeps the last good copy of the read-only API,
   and queues POST /api/segments in IndexedDB while offline, replaying when connectivity returns.
   Map tiles are never cached (size and tile-provider terms). Bump VERSION when shell files change. */
const VERSION = 'rasta-v1-intro';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const SHELL_URLS = [
  '/', '/index.html', '/styles.css', '/app.js', '/map.js', '/i18n.js', '/intro.js', '/logo.svg', '/report.html', '/report.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-maskable.svg',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/exifr/lite.umd.js',
  '/vendor/maplibre/maplibre-gl.js', '/vendor/maplibre/maplibre-gl.css', '/vendor/maplibre-leaflet/leaflet-maplibre-gl.js', '/vendor/googlemutant/Leaflet.GoogleMutant.js',
];
const DATA_URLS = /^\/api\/(standards|config|segments|stats|health)(\?|$)/; // GET only

// ---------- IndexedDB queue ----------
const DB_NAME = 'rasta-queue', STORE = 'uploads';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const queueAdd = async (item) => { const db = await idb(); return tx(db, 'readwrite', (s) => s.add(item)); };
const queueAll = async () => { const db = await idb(); return tx(db, 'readonly', (s) => s.getAll()); };
const queueDelete = async (id) => { const db = await idb(); return tx(db, 'readwrite', (s) => s.delete(id)); };
const queueCount = async () => { const db = await idb(); return tx(db, 'readonly', (s) => s.count()); };

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const c of clients) c.postMessage(msg);
}
async function announceCount() { broadcast({ type: 'rasta:queue', count: await queueCount().catch(() => 0) }); }

// ---------- lifecycle ----------
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(SHELL_URLS.map((u) => cache.add(u))); // a missing optional asset must not block install
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
    await announceCount();
  })());
});

// ---------- fetch ----------
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles, fonts: straight to the network

  if (req.method === 'POST' && url.pathname === '/api/segments') { e.respondWith(postSegment(req)); return; }
  if (req.method !== 'GET') return;

  if (DATA_URLS.test(url.pathname + url.search)) { e.respondWith(networkFirst(req, DATA)); return; }
  if (url.pathname.startsWith('/uploads/')) { e.respondWith(cacheFirst(req, DATA)); return; } // content-addressed → immutable
  if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/')) { e.respondWith(cacheFirst(req, SHELL)); return; }
  if (req.mode === 'navigate' || SHELL_URLS.includes(url.pathname)) { e.respondWith(networkFirst(req, SHELL, req.mode === 'navigate' ? '/index.html' : null)); return; }
});

async function networkFirst(req, cacheName, fallbackPath) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req) || (fallbackPath && await cache.match(fallbackPath));
    if (hit) return hit;
    return new Response(JSON.stringify({ ok: false, error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
}
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

// POST /api/segments: try the network; if it fails at the transport level, store the whole request
// body (multipart or JSON, bytes as sent) and answer with a synthetic "queued" reply.
async function postSegment(req) {
  const stored = req.clone();
  try {
    return await fetch(req);
  } catch (err) {
    const body = await stored.arrayBuffer();
    const name = guessName(body, stored.headers.get('content-type'));
    const id = await queueAdd({ url: new URL(req.url).pathname + new URL(req.url).search, contentType: stored.headers.get('content-type'), body, name, queued_at: Date.now() });
    announceCount();
    if (self.registration.sync) { try { await self.registration.sync.register('rasta-replay'); } catch { /* no background sync */ } }
    const stream = /[?&]stream=1/.test(req.url);
    const payload = { type: 'queued', ok: true, queued: true, queue_id: id, name, error: err.message };
    return new Response(stream ? JSON.stringify(payload) + '\n' : JSON.stringify(payload), { status: 202, headers: { 'content-type': stream ? 'application/x-ndjson; charset=utf-8' : 'application/json' } });
  }
}
function guessName(body, contentType) {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(body.slice(0, 4096));
    if ((contentType || '').includes('application/json')) return JSON.parse(text).name || '';
    const m = /name="name"\r?\n\r?\n([^\r\n]*)/.exec(text);
    return m ? m[1] : '';
  } catch { return ''; }
}

// Replay everything in the queue, oldest first. Stops at the first transport failure (still offline).
let replaying = false;
async function replay() {
  if (replaying) return;
  replaying = true;
  try {
    for (const item of (await queueAll()).sort((a, b) => a.id - b.id)) {
      let res;
      try {
        res = await fetch(item.url.replace(/[?&]stream=1/, ''), { method: 'POST', headers: { 'content-type': item.contentType }, body: item.body });
      } catch { break; } // still offline
      if (res.ok) {
        const seg = await res.json().catch(() => null);
        await queueDelete(item.id);
        broadcast({ type: 'rasta:replayed', ok: true, name: item.name, segment: seg });
      } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const j = await res.json().catch(() => ({}));
        await queueDelete(item.id); // the server will never accept it — do not retry forever
        broadcast({ type: 'rasta:replayed', ok: false, name: item.name, error: j.error || `HTTP ${res.status}` });
      } else break; // 5xx / 429: try again later
    }
  } finally { replaying = false; announceCount(); }
}
self.addEventListener('sync', (e) => { if (e.tag === 'rasta-replay') e.waitUntil(replay()); });
self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'rasta:replay') e.waitUntil(replay());
  if (m.type === 'rasta:queue-count') e.waitUntil(announceCount());
});
