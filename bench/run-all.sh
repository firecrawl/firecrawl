#!/bin/bash
# Runs engines, one at a time, through a corpus.
#   bench/run-all.sh static|live|heldout [engine ...]
# Engines:
#   firecrawl-engine        the release binary on this machine
#   firecrawl-engine-linux  the same engine in a Linux container, browser off
#                           (build it first with bench/build-linux.sh)
#   firecrawl-selfhost      today's self-hosted Firecrawl from its published
#                           images (bench/selfhost/docker-compose.yaml)
# The two container engines need Docker. Put machine-specific Docker setup
# (PATH, DOCKER_HOST) in bench/.work/env.sh, which is git-ignored.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$ROOT/bench/.work"
mkdir -p "$W"
[ -f "$W/env.sh" ] && . "$W/env.sh"
CORPUS="${1:-static}"; shift || true
ENGINES=("$@")
[ ${#ENGINES[@]} -eq 0 ] && ENGINES=(firecrawl-engine firecrawl-engine-linux firecrawl-selfhost)
VM_STATIC="http://host.docker.internal:3900"

wait_http() { # url [seconds]
  for _ in $(seq 1 "${2:-60}"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1")
    [ "$code" != "000" ] && [ "$code" -lt 500 ] && return 0
    sleep 1
  done
  echo "TIMEOUT waiting for $1" >&2; return 1
}

run() { # name base-url [extra runner args...]
  local name="$1" base="$2"; shift 2
  if [ "$CORPUS" = heldout ]; then
    node "$ROOT/bench/heldout.mjs" --engine "$name" --base-url "$base" "$@" 2>&1 | tail -2
  elif [ "$CORPUS" = static ]; then
    node "$ROOT/bench/run.mjs" --engine "$name" --base-url "$base" --corpus static --suite "$@" 2>&1 | tail -9
  else
    node "$ROOT/bench/run.mjs" --engine "$name" --base-url "$base" --corpus live --concurrency 4 --repeat 1 "$@" 2>&1 | tail -9
  fi
}

for e in "${ENGINES[@]}"; do
  echo "================ $e ($CORPUS) ================"
  case "$e" in
    firecrawl-engine)
      "$ROOT/apps/engine/target/release/firecrawl-engine" serve --port 3912 --allow-private > "$W/log-$e.txt" 2>&1 &
      pid=$!; wait_http http://127.0.0.1:3912/health 20
      if [ "$CORPUS" = heldout ]; then run "$e" http://127.0.0.1:3912; else run "$e" http://127.0.0.1:3912 --pid $pid; fi
      kill -TERM $pid; wait $pid 2>/dev/null ;;
    firecrawl-engine-linux)
      docker rm -f fcengine >/dev/null 2>&1
      docker run -d --name fcengine -p 127.0.0.1:3913:3913 --add-host=host.docker.internal:host-gateway \
        -v "$ROOT/apps/engine/target-linux/release:/e:ro" fcengine-base:bench \
        /e/firecrawl-engine --browser never serve --host 0.0.0.0 --port 3913 --token benchtoken --allow-private >/dev/null
      wait_http http://127.0.0.1:3913/health 20
      if [ "$CORPUS" = heldout ]; then run "$e" http://127.0.0.1:3913 --token benchtoken
      else run "$e" http://127.0.0.1:3913 --token benchtoken --static-base "$VM_STATIC" --rss-cmd "$ROOT/bench/docker-rss.sh fcengine"; fi
      docker rm -f fcengine >/dev/null 2>&1 ;;
    firecrawl-selfhost)
      (cd "$ROOT/bench/selfhost" && docker compose up -d >/dev/null 2>&1)
      wait_http http://127.0.0.1:3002/v0/health/liveness 120; sleep 5
      if [ "$CORPUS" = heldout ]; then run "$e" http://127.0.0.1:3002
      else run "$e" http://127.0.0.1:3002 --static-base "$VM_STATIC" \
        --rss-cmd "$ROOT/bench/docker-rss.sh fcbench-api-1 fcbench-playwright-service-1 fcbench-redis-1 fcbench-rabbitmq-1 fcbench-nuq-postgres-1"; fi
      (cd "$ROOT/bench/selfhost" && docker compose down >/dev/null 2>&1) ;;
    *) echo "unknown engine $e" ;;
  esac
done
