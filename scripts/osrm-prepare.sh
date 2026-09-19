#!/usr/bin/env sh
# scripts/osrm-prepare.sh — build a local OSRM foot-routing graph for Delhi so the whole stack can be
# self-hosted (the public router.project-osrm.org demo is not licensed for production traffic).
#
# Usage:  sh scripts/osrm-prepare.sh            # downloads the extract and runs extract/partition/customize
#         OSRM_PBF_URL=... sh scripts/osrm-prepare.sh   # use a smaller city extract if you have one
# Then:   docker compose --profile routing up -d osrm   # serves http://localhost:5000
#
# Needs Docker. Output lands in ./osrm-data (gitignored). The default extract is Geofabrik's
# "northern zone" of India (Delhi, Haryana, Punjab, UP…): roughly 350 MB download and 10–20 min of
# preprocessing with 4–6 GB of RAM. Any .osm.pbf that covers Delhi works.
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)/osrm-data"
IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v5.27.1}"
URL="${OSRM_PBF_URL:-https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf}"
NAME="${OSRM_NAME:-delhi}"

mkdir -p "$DIR"
if [ ! -f "$DIR/$NAME.osm.pbf" ]; then
  echo "▶ downloading $URL"
  curl -fL --retry 3 -o "$DIR/$NAME.osm.pbf" "$URL"
else
  echo "▶ using existing $DIR/$NAME.osm.pbf"
fi

run() { docker run --rm -t -v "$DIR:/data" "$IMAGE" "$@"; }
echo "▶ osrm-extract (foot profile)"
run osrm-extract -p /opt/foot.lua "/data/$NAME.osm.pbf"
echo "▶ osrm-partition"
run osrm-partition "/data/$NAME.osrm"
echo "▶ osrm-customize"
run osrm-customize "/data/$NAME.osrm"
echo "✓ graph ready in $DIR. Start it with:  docker compose --profile routing up -d osrm"
echo "  then set OSRM_BASE=http://localhost:5000 (or http://osrm:5000 inside compose)."
