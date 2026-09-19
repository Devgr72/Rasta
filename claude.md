# Rasta — Crowdsourced Footpath Accessibility Map

## What this is

A web app where people photograph the footpath they just walked, and those photos
become a permanent, shared accessibility map of the city. Anyone can then ask
"what's the best way to walk from A to B if I use a wheelchair?" and get an answer
based on what other people actually saw on the ground.

Built for a 2-hour hackathon by a team of two. Ship the demo, not the platform.

## The one-sentence pitch

Walk a street with your phone, and the city gets a little more mapped.

## Why it matters

Municipal walkability audits in India cost lakhs per kilometre and happen once a
decade, so broken tiles, open drains, missing ramps and 9-inch kerbs stay in place
for years. Nobody has written them down in a form an engineer can act on. For a
senior citizen or a wheelchair user, that's not an inconvenience — a 4-inch lip in
a paver is how an 80-year-old ends up with a fractured hip.

## Hard constraints

- **2 hours of build time. Two developers.**
- **2-minute live demo.** Every feature must survive being shown on stage.
- No auth, no user accounts, no onboarding, no settings page.
- No video processing. Photos only.
- Runs locally on the presenting laptop. Deployment is optional (P2).

## Stack — do not deviate

| Layer | Choice | Why |
|---|---|---|
| Server | Node + Express | No build step, fastest to debug |
| DB | SQLite via `better-sqlite3` | Zero setup, real persistence, one file |
| Frontend | Vanilla JS + Leaflet | No framework build. Leaflet needs no API key |
| Tiles | OpenStreetMap raster tiles | Free, no key, no signup |
| Routing | OSRM public demo server | Free, no key, returns alternatives |
| Model | `claude-fable-5-1` via Anthropic Messages API | The event's model |

Do not introduce React, Next.js, Tailwind build steps, Postgres, Docker, or an ORM.
Every one of those costs more minutes than it saves at this timescale.

## Architecture

```
rasta/
  server.js              Express app, all routes
  db.js                  SQLite schema + queries
  vision.js              Anthropic API calls, prompt, JSON parsing
  scoring.js             Segment score + persona verdicts + route scoring
  knowledge/
    standards.json       THE KNOWLEDGE FILE — see below
  public/
    index.html           Single page, three tabs: Map / Contribute / Route
    app.js               All frontend logic
    map.js               Leaflet setup, segment rendering, route drawing
    styles.css
  data/
    rasta.db             SQLite file (gitignored)
    seed.json            Pre-walked segments, committed
  evals/
    cases.json           Ground truth for the eval photos
    run.js               Scores vision output against ground truth
  uploads/               Photo files (gitignored)
```

## The knowledge file

`knowledge/standards.json` is the most valuable artifact in this repo. It is what
makes the model an accessibility auditor instead of a generic image describer. It
is injected into every vision call. Structure:

```json
{
  "hazard_types": [
    {
      "id": "broken_paver",
      "label_en": "Broken or missing paver tiles",
      "label_hi": "टूटी हुई टाइलें",
      "base_severity": 3,
      "senior_risk": 5,
      "wheelchair_risk": 4,
      "cost_per_sqm_inr": 900,
      "authority": "MCD",
      "standard_ref": "IRC:103 footpath surface continuity"
    }
  ],
  "dimensional_standards": {
    "min_clear_width_m": 1.8,
    "max_kerb_height_mm": 150,
    "max_ramp_gradient": "1:12",
    "tactile_paving_required": true
  },
  "authorities": {
    "MCD": "Municipal Corporation of Delhi — footpath surface, encroachment",
    "PWD": "Public Works Dept — arterial road footpaths, ramps",
    "DJB": "Delhi Jal Board — drain covers, manholes",
    "DISCOM": "BSES/TPDDL — street lighting, poles, transformers"
  }
}
```

Cover roughly 20 hazard types: broken pavers, open drain, missing drain cover,
no kerb ramp, non-compliant ramp gradient, excessive kerb height, obstructing pole,
transformer on path, parked vehicle blocking, vendor encroachment, construction
debris, missing tactile paving, standing water, uneven level change, missing
streetlight, overgrown vegetation, open manhole, broken railing, path width below
minimum, no pedestrian crossing at junction.

**Verify the dimensional numbers against the Harmonised Guidelines before
committing them.** A civil engineer in the audience will check.

## Data model

```sql
CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  name TEXT,                  -- "Kashmere Gate Metro Gate 3 to Lothian Rd"
  start_lat REAL, start_lng REAL,
  end_lat REAL, end_lng REAL,
  length_m REAL,
  score INTEGER,              -- 0-100
  walk_ok INTEGER,            -- 0/1
  wheelchair_ok INTEGER,
  senior_ok INTEGER,
  total_cost_inr INTEGER,
  created_at TEXT
);

CREATE TABLE hazards (
  id INTEGER PRIMARY KEY,
  segment_id INTEGER,
  photo_id INTEGER,
  type_id TEXT,               -- FK to standards.json hazard_types
  severity INTEGER,           -- 1-5
  note TEXT,                  -- model's one-line observation
  bbox TEXT,                  -- JSON: {x,y,w,h} normalized 0-1
  cost_inr INTEGER,
  authority TEXT
);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  segment_id INTEGER,
  filename TEXT,
  created_at TEXT
);
```

## API

```
POST /api/segments          Create segment. Body: {name, start, end, photos[]}
                            Runs vision on all photos IN PARALLEL, scores, persists.
                            Returns the full graded segment.
GET  /api/segments          All segments as GeoJSON for the map.
GET  /api/segments/:id      One segment with its hazards and photos.
POST /api/route             Body: {from:{lat,lng}, to:{lat,lng}}
                            Calls OSRM for alternatives, scores each, returns ranked.
GET  /api/stats             {segments, hazards, km_covered, avg_score}
```

## Vision contract

One API call per photo. All photos for a segment fire in parallel via
`Promise.all`. The model returns strict JSON, no prose, no markdown fences:

```json
{
  "surface_type": "paver | concrete | none | mud",
  "hazards": [
    {
      "type_id": "broken_paver",
      "severity": 4,
      "bbox": {"x": 0.31, "y": 0.62, "w": 0.24, "h": 0.15},
      "note": "Three tiles missing, 60mm drop"
    }
  ],
  "estimated_clear_width_m": 0.9,
  "observations": "Footpath narrows to under a metre past the pole"
}
```

Coordinates are normalized 0–1 so boxes map onto any rendered image size.

Parsing rules: strip markdown fences before `JSON.parse`. On a parse failure,
retry once with a repair instruction. On a second failure, record the photo with
zero hazards rather than crashing the whole segment.

## Scoring

**Segment score (0–100).** Start at 100. Subtract `severity * 6` per hazard,
capped at 85 total deduction. Apply a width penalty: subtract 15 if estimated
clear width is under 1.2m, 25 if under 0.9m. Floor at 5.

**Persona verdicts.** Fail if any hazard's persona-specific risk is 4 or higher:
- `walk_ok` — uses `base_severity`
- `senior_ok` — uses `senior_risk`
- `wheelchair_ok` — uses `wheelchair_risk`, and also fails if width is under 1.2m
  or any `no_kerb_ramp` hazard is present

Each verdict carries a one-line reason naming the specific blocking hazard. Never
show a bare fail without the reason.

**Route score.** Sample the OSRM polyline every 25m. For each sample, find graded
segments whose midpoint is within 40m. Average their scores, weighted by segment
length. Report coverage as the percentage of sampled points that found a segment.
Uncovered stretches render grey and are explicitly labelled "no data" — never
guess a score for an unwalked street.

## Frontend

Three tabs in one page. No routing library, just show/hide.

**Map tab (the landing view).** Leaflet, full bleed. Every graded segment drawn as
a thick polyline coloured by score: red under 40, amber 40–70, green above 70.
Ungraded streets are simply not drawn. Click a segment → side panel with its
photos, the hazard list, persona verdicts, cost to fix. A stats bar across the top:
segments walked, hazards found, km covered.

**Contribute tab.** Click two points on the map to draw the segment. Name it. Drop
in photos. Hit Analyse. Photos appear in a strip; as each result streams back, its
boxes land on the image with a 150ms stagger and the hazard counter ticks up. When
all are done, the score dial animates from 0 to the final number and the segment
appears on the map in its colour.

**Route tab.** Pick A and B on the map. Choose a persona: walking / wheelchair /
senior. Draw the alternative routes returned by OSRM, each coloured by its
accessibility score, with a card per route: score, coverage percentage, distance,
and the worst hazard on it. The recommended route is the highest-scoring one with
at least 40% coverage — not necessarily the shortest.

## Design direction

The app has two visual registers and the contrast between them is the point.

**Scanner (Map, Contribute, Route):** dark slate background `#0F172A`, one amber
accent `#F59E0B`, red `#DC2626` for severe. Nothing else colourful. The score is
the hero element — 120px numeral minimum, animating up from zero. Boxes land
staggered, not all at once.

**Report (P2):** white, serif headings, ruled tables, a reference number at the top
right. It should look like a document a PWD engineer would file, not like a web app.

Large touch targets throughout. Assume the person contributing is standing on a
footpath in the sun holding a phone.

## Build order and cut list

Priorities are strict. Do not start a P1 item while a P0 item is unfinished.

**P0 — must be working by the 1-hour mark**
1. One photo → valid hazard JSON with boxes (**milestone at 0:15, fix nothing else until this works**)
2. Segment creation: draw on map, attach photos, parallel analysis, persist
3. Map rendering with colour-coded segments and the click-through panel

**P1 — 1:00 to 1:30**
4. A→B route comparison with accessibility scoring
5. Persona verdicts with named reasons

**P2 — only if genuinely ahead**
6. Printable report page
7. Pre-filled complaint drafts per hazard
8. Deploy

**Cut in this order if behind:** complaint drafts → report → routing → persona
verdicts → cost estimates. Photo + boxes + map is the irreducible demo.

## Demo requirements — treat these as features

- `data/seed.json` holds the segments walked before the event. It loads on boot so
  the map is never empty. These are real walked segments, not fabricated.
- A cached OSRM response for the demo route lives in `data/demo-route.json`. If the
  OSRM call fails or takes over 3 seconds, fall back to it silently.
- A `?demo=1` flag preloads the demo photos so the upload never depends on finding
  files on stage.
- Cache every vision response keyed by photo hash. Re-running the demo must not
  re-spend tokens or re-risk the API.
- Screenshot every working screen as it lands. Record a full successful run before
  the freeze.

**Hard freeze at 1:45.** No new features after that. The last 15 minutes are
rehearsal only.

## Evals

`evals/cases.json` holds the pre-walked photos with hand-written ground truth —
the hazards actually present in each. `node evals/run.js` reports hits, misses and
false positives.

Run it once around the 1:10 mark and screenshot the result. The demo line is
"41 of 47 hazards across 8 real photos," not "look, it worked." A stated eval
score is worth more than any amount of polish.

## Conventions

- Async/await everywhere. No callbacks, no `.then` chains.
- Every external call (Anthropic, OSRM, tiles) wrapped in try/catch with a visible
  but non-fatal failure state. The demo must never show a stack trace.
- Log every vision call's latency to the console — useful for the demo, useful for
  debugging.
- The API key lives in `.env` and is read only in `vision.js`. It never reaches
  the browser.
- Commit after every working feature. A working commit is a rollback point.