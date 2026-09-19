# Rasta — crowdsourced footpath accessibility map

> Walk a street with your phone, and the city gets a little more mapped.

## What this is

A web app where people photograph the footpath they just walked, and those photos become a permanent,
shared accessibility map of the city. Anyone can then ask "what's the best way to walk from A to B if I
use a wheelchair?" and get an answer based on what other people actually saw on the ground.

Municipal walkability audits in India cost lakhs per kilometre and happen once a decade, so broken tiles,
open drains, missing ramps and 9-inch kerbs stay in place for years. Nobody has written them down in a
form an engineer can act on. For a senior citizen or a wheelchair user that is not an inconvenience: a
4-inch lip in a paver is how an 80-year-old ends up with a fractured hip.

Each photo is audited by `claude-fable-5-1` against `knowledge/standards.json` (21 hazard types drawn from
the Harmonised Guidelines 2021 and IRC:103-2012). The stretch lands on a shared Leaflet map coloured by
score, with hazards boxed on the photos, a verdict for walkers, wheelchair users and seniors, the repair
cost and the authority responsible. Routes from A to B are compared by how accessible they actually are.

**Stack:** Node 20+, Express 5, SQLite via `better-sqlite3`, vanilla JS, Leaflet. No build step, no
framework, no ORM.

## Local setup

```bash
git clone https://github.com/Devgr72/Rasta.git && cd Rasta
npm install
cp .env.example .env        # paste ANTHROPIC_API_KEY, or leave it empty for mock vision
npm start                   # http://localhost:3000
```

`node server.js` needs nothing beyond `.env`. On first boot the empty database is seeded from
`data/seed.json` so the map is never blank.

Without an API key the server runs in **mock vision** mode: every screen works, an amber badge says so,
and no tokens are spent. Force it with `npm run mock` or `RASTA_MOCK_VISION=1`.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with `node --watch` (restarts on file change) |
| `npm run mock` | Run with mock vision, cross-platform |
| `npm test` | Unit and API tests (`node:test`, no extra dependency). `npm test scoring` runs one suite |
| `npm run lint` | `node --check` on every `.js` file |
| `npm run eval` | Score vision output against `evals/cases.json` |
| `npm run test:vision -- photo.jpg` | One photo in, hazard JSON out |
| `npm run check` | Headless-Chrome smoke test of the running app (tabs, panel, report) |
| `npm run shoot` | Headless-Chrome screenshot walk-through |

The Chrome-driven scripts need Google Chrome installed. Set `CHROME=/path/to/chrome` if it is not in
the default location for your OS.

## Environment variables

Everything is read from `.env` (via `dotenv`) or the process environment. Only `vision.js` reads the API key;
it never reaches the browser.

| Variable | Read in | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `vision.js` | — | Anthropic API key. Empty or missing → mock vision mode |
| `RASTA_MODEL` | `vision.js` | `claude-fable-5-1` | Model id for the vision audit |
| `RASTA_MOCK_VISION` | `vision.js` | — | `1` forces deterministic mock results, no API calls |
| `RASTA_DB` | `db.js` | `data/rasta.db` | SQLite file path (`:memory:` works for tests) |
| `RASTA_UPLOAD_DIR` | `server.js` | `uploads/` | Where photo files are written with the local storage driver |
| `RASTA_VISION_CACHE_DIR` | `vision.js` | `data/vision-cache/` | Legacy hackathon file cache. Files found here are imported into the `vision_calls` table on first use |
| `RASTA_STORAGE` | `lib/storage.js` | `local` | `local` (disk) or `s3` (AWS S3, Cloudflare R2, MinIO, any S3-compatible bucket) |
| `RASTA_S3_BUCKET` | `lib/storage.js` | — | Bucket name (required for `s3`) |
| `RASTA_S3_ENDPOINT` | `lib/storage.js` | AWS regional endpoint | Custom endpoint, e.g. `https://<account>.r2.cloudflarestorage.com` or `http://minio:9000`. Implies path-style URLs |
| `RASTA_S3_REGION` | `lib/storage.js` | `auto` | Signing region (`auto` for R2) |
| `RASTA_S3_ACCESS_KEY_ID` / `RASTA_S3_SECRET_ACCESS_KEY` | `lib/storage.js` | falls back to `AWS_*` | Credentials |
| `RASTA_S3_PREFIX` | `lib/storage.js` | empty | Key prefix, e.g. `photos/` |
| `RASTA_S3_PUBLIC_URL` | `lib/storage.js` | unset | Public/CDN base for photo URLs. Unset → the server proxies `/uploads/<name>` from the bucket so URLs are identical under both drivers |
| `RASTA_S3_FORCE_PATH_STYLE` | `lib/storage.js` | auto | `1`/`0` to override path- vs virtual-host-style addressing |
| `PORT` | `server.js` | `3000` | HTTP port |
| `OSRM_BASE` | `server.js` | `https://router.project-osrm.org` | OSRM routing server base URL |
| `RASTA_TILE_URL` | `server.js` | OSM tile URL template | Tile host; its origin is added to the CSP `img-src` |
| `RASTA_VISION_CONCURRENCY` | `vision.js` | `4` | Max model calls in flight across all requests |
| `RASTA_DAILY_TOKEN_BUDGET` | `vision.js` | unlimited | Input + output tokens allowed per UTC day. Once reached, uncached photos return zero hazards with `meta.error = "daily budget reached"` |
| `RASTA_RATE_LIMIT_SEGMENTS` | `server.js` | `30` | `POST /api/segments` per IP per window. `0` disables |
| `RASTA_RATE_LIMIT_ROUTE` | `server.js` | `120` | `POST /api/route` per IP per window. `0` disables |
| `RASTA_RATE_LIMIT_WINDOW_MIN` | `server.js` | `15` | Rate-limit window in minutes |
| `RASTA_TRUST_PROXY` | `server.js` | unset | Number of reverse-proxy hops to trust for the client IP (set `1` on Render/Fly/nginx) |
| `RASTA_MAX_UPLOAD_MB` | `server.js` | `40` | Total photo bytes allowed in one request (also the JSON body limit) |
| `RASTA_MAX_IMAGE_PX` | `server.js` | `6000` | Longest decoded side allowed per photo |
| `RASTA_ADMIN_TOKEN` | `server.js` | unset | Enables `DELETE /api/segments/:id` with `Authorization: Bearer <token>` |
| `BASE` | `scripts/*.js` | `http://localhost:3000` | Target for the browser scripts |
| `CHROME` | `scripts/*.js` | per-OS default | Chrome binary for the browser scripts |
| `OUT` | `scripts/*.js` | OS temp dir | Screenshot output directory |

## Photos: evals, demo and seed

Photos are not committed to the repo. Three places expect them:

**Eval photos** — `evals/photos/`. `evals/cases.json` lists eight filenames with the hazard ids actually
present in each. Drop the photos in with those exact names. `npm run eval` reports hits, misses and false
positives per photo, and lists any file that is missing as its own row instead of aborting.

**Demo photos** — `public/demo/`. `?demo=1` on the home page preloads the stretch and photos named in
`public/demo/manifest.json` into the Contribute tab so the upload never depends on finding files on stage.
Add JPGs to the folder and list their filenames in the manifest's `photos` array.

**Seed photos** — `data/seed.json` holds ten pre-walked Delhi segments that load on first boot. They carry
hazards and observations but no image files. To attach photos, walk the stretch again with the Contribute
tab, or place files in `uploads/` and set each seed photo's `filename` to match.

## API

All responses are JSON. Fields are only ever added, never renamed or removed.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | `{ok, model, mock, concurrency, daily_token_budget, budget_reached}` |
| `GET` | `/api/stats` | `{segments, hazards, km_covered, avg_score, total_cost_inr, wheelchair_ok_count, senior_ok_count, vision:{today, total, budget, budget_reached, concurrency}}` — token usage per UTC day and overall |
| `GET` | `/api/standards` | The knowledge file |
| `GET` | `/api/segments` | GeoJSON `FeatureCollection`; each feature's `properties` is a segment summary |
| `GET` | `/api/segments/:id` | One segment with `geometry`, `photos[]` (each with `url, lat, lng, taken_at`), `hazards[]` and `verdicts` |
| `POST` | `/api/segments` | Create a segment. Multipart `name, start, end, photos[]` (up to 12), or JSON `{name, start, end, photos:[dataURL]}`. Runs vision on every photo in parallel, scores, persists, returns the graded segment with `201`. Optional `photo_meta` (JSON array of `{lat,lng,taken_at}` aligned with the photos). Add `?stream=1` for NDJSON: `{type:"start"}`, one `{type:"photo"}` per result as it lands, then `{type:"segment"}` |
| `POST` | `/api/route` | `{from:{lat,lng}, to:{lat,lng}, persona}` → OSRM alternatives scored against walked segments, with `coverage`, `worst_hazard`, `persona_blockers` and `recommended_index`. Falls back to `data/demo-route.json` if OSRM fails or exceeds 3 s |
| `DELETE` | `/api/segments/:id` | Takedown. Only exists when `RASTA_ADMIN_TOKEN` is set; needs `Authorization: Bearer <token>`. Cascades to photos and hazards and removes orphaned upload files |

### Storage, cache and schema

- **Schema migrations.** `db.js` holds an ordered array of SQL migrations and a `schema_version` table. Every boot applies whatever is missing inside a transaction. A database created by the hackathon build (tables but no version table) is baselined at version 1 and then upgraded. Migration 2 adds `vision_calls`, `segments.geometry` (GeoJSON LineString) and `photos.photo_lat / photo_lng / taken_at`.
- **Photo files** go through `lib/storage.js`: local disk by default, or an S3-compatible bucket with `RASTA_STORAGE=s3`. The S3 driver signs requests itself (SigV4, verified against the AWS test vectors) so no SDK ships in the image. Photo URLs in API responses work under either driver.
- **Vision cache** lives in the `vision_calls` table: the newest successful row for a photo hash carries the result, so a hit is one indexed read and survives container rebuilds when `data/` is on a volume. Old `data/vision-cache/*.json` files are imported the first time they are asked for.
- **EXIF.** Before a photo is stored, GPS and `DateTimeOriginal` are read into the photo row, then all metadata segments are stripped from the file. Only a minimal Orientation tag is written back so rotated phone photos still display upright. Times are kept as the camera's wall-clock string (with the EXIF offset when present) rather than guessed into a timezone. Browsers strip EXIF when they resize, so the client may also send `photo_meta=[{lat,lng,taken_at}]` aligned with `photos[]`; EXIF wins when both exist.

### Protections

- `POST /api/segments` and `POST /api/route` are rate limited per IP (see env vars above); a 429 comes back as JSON with `retry_after_min`.
- At most **4** model calls are in flight at once across the whole server (`RASTA_VISION_CONCURRENCY`). Photos in one segment still start together; extras queue for a slot.
- Every Anthropic response's token usage is written to the `vision_calls` table. With `RASTA_DAILY_TOKEN_BUDGET` set, once the UTC day's input + output tokens pass it, new uncached photos are stored with zero hazards and `meta.error = "daily budget reached"`; the Contribute tab shows a toast and the ledger shows a badge. Cache hits and mock mode are unaffected.
- Uploads are capped at 12 photos, 8 MB each, `RASTA_MAX_UPLOAD_MB` in total, and each image's header is read to reject anything over `RASTA_MAX_IMAGE_PX` a side or not a JPEG/PNG/WebP/GIF before any model call.
- `helmet` sets security headers with a CSP that permits only the tile host, Google Fonts and `blob:`/`data:` images. The report page's script lives in `public/report.js` so `script-src` stays `'self'`.

### Scoring (unchanged from the field-checked rules)

Segment score starts at 100. Subtract `severity × 6` per hazard, capped at 85. Subtract 15 if the clear
width is under 1.2 m, 25 if under 0.9 m. Floor at 5.

Persona verdicts fail when any hazard's persona risk is 4 or more. Wheelchair also fails on clear width
under 1.2 m or any `no_kerb_ramp` hazard. Every fail names the blocking hazard.

Routes are sampled every 25 m; graded segments within 40 m contribute their score weighted by length.
Coverage is the share of samples that found data. Under 40% coverage a route is drawn grey and labelled
"no data", never guessed.

## Running the evals

```bash
npm run eval
```

Requires the photos in `evals/photos/` (see above). Output is a table per photo plus a summary line such
as `41 of 47 hazards found across 8 photos`. The full report is written to `evals/last-run.json`
(gitignored). Vision responses are cached by photo hash, so re-running costs nothing.

## Deploying

_To be filled in Phase 6 (Docker image, docker-compose, hosted volume, key rotation, SQLite restore)._

Until then: any Node 20+ host with a persistent disk works. Mount `data/` and `uploads/`, set
`ANTHROPIC_API_KEY` and `PORT`. Leaflet is served from `node_modules`; map tiles come from
openstreetmap.org and fonts from Google.

## Layout

```
server.js            Express app, all routes, seeding, OSRM with cached fallback
db.js                SQLite schema + queries (better-sqlite3)
vision.js            Anthropic call, knowledge injection, JSON repair, hash cache — the only file with the key
scoring.js           Segment score, persona verdicts, cost, route scoring (pure functions)
knowledge/           standards.json — 21 hazard types, dimensional standards, authorities
public/              index.html, app.js, map.js, styles.css, report.html, demo/
data/                seed.json, demo-route.json (rasta.db and vision-cache/ are gitignored)
evals/               cases.json ground truth, run.js, photos/ (gitignored contents)
scripts/             lint.js, mock.js, browser-check.js, shoot.js
tests/               node:test suites
```
