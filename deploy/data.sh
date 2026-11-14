#!/usr/bin/env bash
# Rebuilds the published data on a server from NASA's own sources, instead of copying it from a
# laptop: downloads the raw fire data into pipeline/data, runs the pipeline, and publishes into
# web/public/data, where the web app reads it.
#
#   deploy/data.sh build    download and build (about 5 hours, 10 GB of disk; resumes if stopped)
#   deploy/data.sh status   what is published and what the database holds
#
# Downloads stop at UNTIL (default 2026-11-13, the last day in the data the app was built with),
# so the result matches that data instead of adding newer days.
# Needs Python 3.12 or newer (PYTHON=/path/to/python3.12 to choose one) and FIRMS_MAP_KEY in the
# environment or in pipeline/.env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPELINE="$ROOT/pipeline"
WEB_DATA="$ROOT/web/public/data"
LOGS="$PIPELINE/data/logs"
PYTHON="${PYTHON:-python3}"
UNTIL="${UNTIL:-2026-11-13}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "error: $*" >&2; exit 1; }

preflight() {
  "$PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null ||
    die "$PYTHON is missing or older than Python 3.12; set PYTHON=/path/to/python3.12"
  if [[ -z "${FIRMS_MAP_KEY:-}" ]] && ! grep -q '^FIRMS_MAP_KEY=.' "$PIPELINE/.env" 2>/dev/null; then
    die "FIRMS_MAP_KEY is not set: export it, or put FIRMS_MAP_KEY=... in pipeline/.env (chmod 600)"
  fi
  mkdir -p "$LOGS" "$WEB_DATA"
  if command -v flock >/dev/null; then
    exec 9>"$PIPELINE/data/.build.lock"
    flock -n 9 || die "another build is still running"
  fi
}

download() {
  local source=$1
  shift
  log "download: $source"
  (cd "$PIPELINE" && "$PYTHON" -I hotornot/ingest/ingest.py "$source" "$@") 2>&1 | tee -a "$LOGS/$source.log"
}

step() {
  local name=$1
  shift
  log "step: $name"
  (cd "$PIPELINE" && "$PYTHON" -m hotornot "$name" "$@") 2>&1 | tee -a "$LOGS/$name.log"
}

case "${1:-}" in
  build)
    preflight
    log "building the data up to $UNTIL"
    download boundaries
    download cmr --until "$UNTIL"
    download firms
    download api --until "$UNTIL"
    step normalize
    step coverage --until "$UNTIL"
    step static-mask
    step series
    step matchups
    step model
    step validate
    step publish --method model_v1 --copy-to "$WEB_DATA"
    log "published: $(cat "$WEB_DATA/latest.json")"
    ;;
  status)
    if [[ -f "$WEB_DATA/latest.json" ]]; then
      log "published: $(cat "$WEB_DATA/latest.json"), $(du -sh "$WEB_DATA" | cut -f1) in web/public/data"
    else
      log "nothing published yet in web/public/data"
    fi
    if [[ -f "$PIPELINE/data/hotornot.sqlite" ]]; then
      (cd "$PIPELINE" && "$PYTHON" -m hotornot info raw_files hotspots)
    else
      log "no pipeline database yet: run deploy/data.sh build"
    fi
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
