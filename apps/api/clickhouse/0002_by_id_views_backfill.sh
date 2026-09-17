#!/usr/bin/env bash
# Backfill the by-id tables from 0002_by_id_views.sql, one month at a time.
#
# Materialized views only see rows inserted after they exist. Run this once,
# after 0002_by_id_views.sql, to copy history. Each statement reads one
# partition of the base table and is safe to re-run for a month that failed:
# it deletes that month from the target first.
#
# Usage:
#   CLICKHOUSE_URL='https://user:pass@host:8443/?database=default' \
#     ./0002_by_id_views_backfill.sh 202501 202509
#
# The month range is inclusive. Start at the oldest month the base tables
# hold (SELECT min(toYYYYMM(created_at)) FROM requests). Stop at the month
# in which the views were created; rows from that month onward that arrived
# after the views existed are already present, and the DELETE keeps the
# re-copy from doubling them.
set -euo pipefail

from="${1:?first month, e.g. 202501}"
to="${2:?last month, e.g. 202509}"
url="${CLICKHOUSE_URL:?CLICKHOUSE_URL is required}"

ch() {
  curl -sS --fail --max-time 7200 "$url" --data-binary "$1"
}

month="$from"
while [ "$month" -le "$to" ]; do
  echo "== $month"

  ch "ALTER TABLE requests_by_id DROP PARTITION $month"
  ch "INSERT INTO requests_by_id
      SELECT id, team_id, kind, api_version, created_at, origin, integration,
             target_hint, api_key_id, external_request_id
      FROM requests WHERE toYYYYMM(created_at) = $month"

  ch "ALTER TABLE scrapes_by_id DROP PARTITION $month"
  ch "INSERT INTO scrapes_by_id
      SELECT id, request_id, team_id, is_successful, credits_cost, created_at
      FROM scrapes WHERE toYYYYMM(created_at) = $month"

  ch "ALTER TABLE scrapes_by_request DROP PARTITION $month"
  ch "INSERT INTO scrapes_by_request
      SELECT request_id, id, team_id, is_successful,
             toUInt8(
               is_successful = false
               AND ifNull(error, '') != ''
               AND NOT startsWith(ifNull(error, ''), 'SCRAPE_RACED_REDIRECT_ERROR|')
               AND position(ifNull(error, ''), 'URL does not match required include pattern') = 0
               AND position(ifNull(error, ''), 'includePaths parameter') = 0
               AND position(ifNull(error, ''), 'URL matches exclude pattern') = 0
               AND position(ifNull(error, ''), 'excludePaths parameter') = 0
               AND position(ifNull(error, ''), 'URL exceeds maximum crawl depth') = 0
               AND position(ifNull(error, ''), 'Maximum discovery depth reached') = 0
               AND position(ifNull(error, ''), 'maximum discovery depth') = 0
             ) AS is_real_error,
             credits_cost, created_at
      FROM scrapes WHERE toYYYYMM(created_at) = $month"

  # next month
  y=${month:0:4}; m=${month:4:2}
  if [ "$m" = "12" ]; then month="$((y + 1))01"; else month="$y$(printf '%02d' $((10#$m + 1)))"; fi
done
echo "done"
