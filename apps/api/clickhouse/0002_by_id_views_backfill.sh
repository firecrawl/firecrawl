#!/usr/bin/env bash
# Backfill the lookup tables from 0002_by_id_views.sql, one month at a time.
#
# Materialized views only see rows inserted after they exist. Run this once,
# after 0002_by_id_views.sql, to copy history. Each statement reads one
# partition of the base table and is safe to re-run for a month that failed.
#
# Usage:
#   CLICKHOUSE_URL='https://host:8443/?database=default' \
#   CLICKHOUSE_USER='default' CLICKHOUSE_PASSWORD='...' \
#     ./0002_by_id_views_backfill.sh 202501 202509 '2026-09-18 10:00:00'
#
#   <from> <to>   inclusive YYYYMM range, oldest first. Start at
#                 SELECT min(toYYYYMM(created_at)) FROM requests.
#   <views_at>    UTC time the views were created ('YYYY-MM-DD HH:MM:SS').
#                 Only rows older than this are copied; the views own the rest.
#
# Months before the month of <views_at> are dropped and re-copied, so a failed
# month can be re-run. The month of <views_at> itself is live: it is never
# dropped (the views are writing into it), only copied up to <views_at>. Rows
# with created_at just before <views_at> that ClickPipes delivered after the
# views existed are both copied and view-written; the ReplacingMergeTree
# engine collapses those exact duplicates on merge.
#
# Credentials never appear on a command line: curl reads them from a config
# passed on a private file descriptor.
set -euo pipefail

from="${1:?first month, e.g. 202501}"
to="${2:?last month, e.g. 202509}"
views_at="${3:?UTC time the views were created, e.g. '2026-09-18 10:00:00'}"
url="${CLICKHOUSE_URL:?CLICKHOUSE_URL (no credentials) is required}"
user="${CLICKHOUSE_USER:?CLICKHOUSE_USER is required}"
password="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"

month_ok() {
  [[ "$1" =~ ^[0-9]{4}(0[1-9]|1[0-2])$ ]]
}
month_ok "$from" || { echo "from: expected YYYYMM with month 01-12, got $from" >&2; exit 2; }
month_ok "$to" || { echo "to: expected YYYYMM with month 01-12, got $to" >&2; exit 2; }
[ "$from" -le "$to" ] || { echo "from ($from) is after to ($to)" >&2; exit 2; }
[[ "$views_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] \
  || { echo "views_at: expected 'YYYY-MM-DD HH:MM:SS', got $views_at" >&2; exit 2; }
live_month="${views_at:0:4}${views_at:5:2}"
[ "$to" -le "$live_month" ] || { echo "to ($to) is after the month the views were created ($live_month); the views own those rows" >&2; exit 2; }

# curl config strings are double-quoted with backslash escapes, so a quote or
# backslash inside a credential must be escaped or it truncates the value.
curl_quote() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  printf '%s' "$v"
}

ch() {
  curl -sS --fail --max-time 7200 \
    -K <(printf 'user = "%s:%s"\n' "$(curl_quote "$user")" "$(curl_quote "$password")") \
    "$url" --data-binary "$1"
}

copy() {
  local table="$1" month="$2" select="$3"
  if [ "$month" -lt "$live_month" ]; then
    ch "ALTER TABLE $table DROP PARTITION $month"
  fi
  ch "INSERT INTO $table $select
      WHERE toYYYYMM(created_at) = $month
        AND created_at < parseDateTime64BestEffort('$views_at', 9, 'UTC')"
}

month="$from"
while [ "$month" -le "$to" ]; do
  echo "== $month"

  copy requests_by_id "$month" \
    "SELECT id, team_id, kind, api_version, created_at, origin, integration,
            target_hint, api_key_id, external_request_id
     FROM requests"

  copy scrapes_by_id "$month" \
    "SELECT id, request_id, team_id, is_successful, credits_cost, created_at
     FROM scrapes"

  copy scrapes_by_time "$month" \
    "SELECT created_at, id, request_id, team_id, is_successful, credits_cost
     FROM scrapes"

  copy scrapes_by_request "$month" \
    "SELECT request_id, id, team_id, is_successful,
            toUInt8(
              is_successful = false
              AND ifNull(error, '') != ''
              AND NOT startsWith(ifNull(error, ''), 'SCRAPE_RACED_REDIRECT_ERROR|')
              AND position(ifNull(error, ''), 'URL does not match required include pattern') = 0
              AND position(ifNull(error, ''), 'includePaths parameter') = 0
              AND position(ifNull(error, ''), 'URL matches exclude pattern') = 0
              AND position(ifNull(error, ''), 'excludePaths parameter') = 0
              AND position(ifNull(error, ''), 'exceeds the maximum crawl depth') = 0
              AND position(ifNull(error, ''), 'Maximum discovery depth reached') = 0
              AND position(ifNull(error, ''), 'maximum discovery depth') = 0
            ) AS is_real_error,
            credits_cost, created_at
     FROM scrapes"

  # next month
  y=${month:0:4}; m=${month:4:2}
  if [ "$m" = "12" ]; then month="$((y + 1))01"; else month="$y$(printf '%02d' $((10#$m + 1)))"; fi
done
echo "done"
