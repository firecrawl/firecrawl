#!/usr/bin/env bash
# Firecrawl full-stack startup script
# Usage: ./start.sh          — start everything
#        ./start.sh stop      — stop the API (backing services keep running)
#        ./start.sh status    — show status of every component
#        ./start.sh restart   — stop API then start everything fresh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$SCRIPT_DIR/apps/api"
LOG_DIR="/tmp/firecrawl-logs"
PID_FILE="/tmp/firecrawl-api.pid"

mkdir -p "$LOG_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}ℹ${NC} $1"; }

# ── Redis ─────────────────────────────────────────────────────────────────────
start_redis() {
  if redis-cli ping >/dev/null 2>&1; then
    ok "Redis already running"
    return
  fi
  info "Starting Redis..."
  nohup redis-server --daemonize yes --logfile "$LOG_DIR/redis.log" >/dev/null 2>&1
  sleep 1
  redis-cli ping >/dev/null 2>&1 && ok "Redis started" || fail "Redis failed to start — check $LOG_DIR/redis.log"
}

# ── PostgreSQL ────────────────────────────────────────────────────────────────
start_postgres() {
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    ok "PostgreSQL already running"
    return
  fi
  info "Starting PostgreSQL..."
  sudo pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  sleep 2
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    ok "PostgreSQL started"
  else
    fail "PostgreSQL failed — check pg logs"
    exit 1
  fi
}

# ── RabbitMQ ──────────────────────────────────────────────────────────────────
start_rabbitmq() {
  if nc -z localhost 5672 2>/dev/null; then
    ok "RabbitMQ already running"
    return
  fi
  info "Starting RabbitMQ..."
  nohup sudo /usr/sbin/rabbitmq-server >"$LOG_DIR/rabbitmq.log" 2>&1 &
  disown $!
  for i in $(seq 1 15); do
    nc -z localhost 5672 2>/dev/null && ok "RabbitMQ started" && return
    sleep 1
  done
  fail "RabbitMQ failed to start — check $LOG_DIR/rabbitmq.log"
  exit 1
}

# ── Firecrawl API ─────────────────────────────────────────────────────────────
stop_api() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      info "Stopping Firecrawl API (PID $PID)..."
      kill "$PID" 2>/dev/null || true
      sleep 2
      kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  pkill -9 -f "dist/src/(harness|index|services)" 2>/dev/null || true
  fuser -k 3002/tcp 3004/tcp 3005/tcp 3011/tcp 2>/dev/null || true
  sleep 1
}

start_api() {
  stop_api  # clean slate

  info "Starting Firecrawl API..."
  cd "$API_DIR"
  nohup bash -c "DOTENV_CONFIG_PATH=.env.local node dist/src/harness.js --start-built" \
    >"$LOG_DIR/api.log" 2>&1 &
  API_PID=$!
  disown $API_PID
  echo $API_PID > "$PID_FILE"

  info "Waiting for API on :3002 (up to 60s)..."
  for i in $(seq 1 60); do
    nc -z localhost 3002 2>/dev/null && ok "Firecrawl API ready (PID $API_PID)" && return
    sleep 1
    # Check if process died early
    if ! kill -0 $API_PID 2>/dev/null; then
      fail "API process died — last lines of log:"
      tail -20 "$LOG_DIR/api.log"
      return 1
    fi
  done
  fail "API did not come up within 30s — check $LOG_DIR/api.log"
  return 1
}

# ── Status ────────────────────────────────────────────────────────────────────
show_status() {
  echo ""
  echo -e "${BLUE}══ Firecrawl Status ══${NC}"
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1   && ok "PostgreSQL   :5432" || fail "PostgreSQL   :5432"
  redis-cli ping >/dev/null 2>&1                      && ok "Redis        :6379" || fail "Redis        :6379"
  nc -z localhost 5672 2>/dev/null                    && ok "RabbitMQ     :5672" || fail "RabbitMQ     :5672"
  nc -z localhost 3002 2>/dev/null                    && ok "API          :3002" || fail "API          :3002"
  nc -z localhost 3004 2>/dev/null                    && ok "Extract wkr  :3004" || fail "Extract wkr  :3004"
  nc -z localhost 3005 2>/dev/null                    && ok "Queue wkr    :3005" || fail "Queue wkr    :3005"
  nc -z localhost 3011 2>/dev/null                    && ok "NuQ prefetch :3011" || fail "NuQ prefetch :3011"

  echo ""
  WCOUNT=$(ps aux | grep -cE "dist/src/(services|index)" || true)
  info "Worker processes: $WCOUNT"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    kill -0 "$PID" 2>/dev/null && info "Harness PID: $PID" || warn "Harness PID $PID no longer alive"
  fi
  echo ""
}

# ── Quick smoke test ──────────────────────────────────────────────────────────
smoke_test() {
  echo -e "${BLUE}══ Smoke Tests ══${NC}"
  API_KEY="fc-b6592fd7bdef4e238c843d11a91c66b7"

  run_test() {
    local name="$1" payload="$2" endpoint="$3"
    RESULT=$(curl -s --max-time 20 "http://localhost:3002$endpoint" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $API_KEY" \
      -d "$payload")
    if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" 2>/dev/null; then
      ok "$name"
    else
      fail "$name"
      echo "    Response: $(echo "$RESULT" | head -c 200)"
    fi
  }

  run_test "Scrape (default)"           '{"url":"https://example.com","formats":["markdown"]}' /v1/scrape
  run_test "Scrape (hermes integration)" '{"url":"https://example.com","formats":["markdown"],"integration":"hermes"}' /v1/scrape
  run_test "Map"                         '{"url":"https://example.com"}' /v1/map
  run_test "Map (hermes integration)"    '{"url":"https://example.com","integration":"hermes"}' /v1/map
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
CMD="${1:-start}"

case "$CMD" in
  start)
    echo -e "${BLUE}══ Starting Firecrawl ══${NC}"
    start_redis
    start_postgres
    start_rabbitmq
    start_api
    show_status
    smoke_test
    ;;
  stop)
    echo -e "${BLUE}══ Stopping Firecrawl API ══${NC}"
    stop_api
    ok "API stopped (Redis/PostgreSQL/RabbitMQ still running)"
    ;;
  restart)
    echo -e "${BLUE}══ Restarting Firecrawl ══${NC}"
    start_redis
    start_postgres
    start_rabbitmq
    start_api
    show_status
    smoke_test
    ;;
  status)
    show_status
    ;;
  test)
    smoke_test
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|test}"
    exit 1
    ;;
esac
