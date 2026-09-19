# Rasta — crowdsourced footpath accessibility map

Walk a street with your phone, and the city gets a little more mapped.

People photograph the footpath they just walked. Each photo is audited by Claude against Indian
accessibility standards (Harmonised Guidelines 2021, IRC:103) and the stretch lands on a shared map,
coloured by score, with hazards boxed on the photos, a verdict for walkers, wheelchair users and
seniors, the repair cost, and the authority responsible. Anyone can then compare routes from A to B
by how accessible they actually are on the ground.

Built for a 2-hour hackathon. Node + Express + SQLite + vanilla JS + Leaflet. No build step.

## Run it

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY (and ANTHROPIC_WORKSPACE_ID for org-level keys)
npm start                   # http://localhost:3000
```

Without a key the server boots in **mock vision** mode (an amber badge says so) so every screen still
works. Set `RASTA_MOCK_VISION=1` to force it and avoid spending tokens.

```bash
node test-vision.js path/to/footpath.jpg     # one photo -> hazard JSON with boxes
node evals/run.js                            # hits / misses / false positives vs evals/cases.json
npm run shoot                                # headless Chrome walk-through, screenshots to /tmp/shots
```

## Demo aids

- `data/seed.json` loads on first boot so the map is never empty.
- `data/demo-route.json` is a cached OSRM response; used silently if OSRM fails or takes over 3 s.
- `http://localhost:3000/?demo=1` preloads the stretch and photos listed in `public/demo/manifest.json`.
- Vision responses are cached in `data/vision-cache/` by photo hash. Re-running the demo costs nothing.
- `/report.html?id=<segment>` is the printable engineer's report with a reference number.

## Layout

```
server.js        Express, all routes, seeding, OSRM with fallback
db.js            SQLite schema + queries (better-sqlite3)
vision.js        Anthropic call, knowledge injection, JSON repair, hash cache — the only file with the key
scoring.js       Segment score, persona verdicts, cost, route scoring
knowledge/standards.json   21 hazard types, dimensional standards, authorities
public/          index.html, app.js, map.js, styles.css, report.html
data/            seed.json, demo-route.json (rasta.db and vision-cache are gitignored)
evals/           cases.json ground truth + run.js
```

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/segments` | multipart `name, start, end, photos[]` or JSON with base64 photos. `?stream=1` returns NDJSON, one line per photo as it lands |
| GET | `/api/segments` | GeoJSON FeatureCollection |
| GET | `/api/segments/:id` | segment with photos and hazards |
| POST | `/api/route` | `{from, to, persona}` -> scored OSRM alternatives, `recommended_index` |
| GET | `/api/stats` | segments, hazards, km, average, total cost |
| GET | `/api/standards` | the knowledge file |

## Scoring

Start at 100. Subtract `severity × 6` per hazard (max 85). Subtract 15 if the clear width is under
1.2 m, 25 if under 0.9 m. Floor at 5. Persona verdicts fail when any hazard's persona risk is 4 or
more; wheelchair also fails on width under 1.2 m or a missing kerb ramp. Every fail names the hazard.

Routes are sampled every 25 m; graded segments within 40 m contribute their score weighted by length.
Coverage is the share of samples that found data. Under 40% coverage a route is drawn grey and
labelled "no data", never guessed.

## Deploying

Any Node host with a persistent disk works (Render, Railway, Fly, a VPS). Mount `data/` and
`uploads/`, set `ANTHROPIC_API_KEY` and `PORT`. Map tiles come from openstreetmap.org and fonts
from Google; Leaflet is served from `node_modules`.
