-- request_children: every result blob id a request produced, keyed by the
-- request id. Fed by materialized views from the Pub/Sub-ingested job tables,
-- so a row appears as soon as ClickPipes delivers the job row (seconds).
--
-- Consumers:
--   * ZDR cleanup (apps/api/src/lib/zdrcleaner.ts) resolves the GCS blobs to
--     delete for a request 24 hours after it was logged.
--
-- TTL: ZDR cleanup needs 24 hours plus retry headroom; 30 days is generous and
-- keeps the table small (three UUID-ish columns per job row).
--
-- Run once against the analytics ClickHouse service, top to bottom: the views
-- only see rows inserted after they exist, so the INSERTs at the end copy the
-- recent history the cleaner can still be asked about (a request is cleaned
-- 24 hours after it was logged, and a failed cleanup job is retried). Rows the
-- views write while the copy runs collide with copied rows; the
-- ReplacingMergeTree engine collapses those exact duplicates and the cleaner
-- reads with DISTINCT.

CREATE TABLE IF NOT EXISTS request_children
(
    request_id UUID,
    id UUID,
    source LowCardinality(String),
    created_at DateTime64(9)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (request_id, id)
TTL toDateTime(created_at) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS request_children_from_scrapes
TO request_children
AS SELECT request_id, id, 'scrapes' AS source, created_at
FROM scrapes;

CREATE MATERIALIZED VIEW IF NOT EXISTS request_children_from_searches
TO request_children
AS SELECT request_id, id, 'searches' AS source, created_at
FROM searches;

CREATE MATERIALIZED VIEW IF NOT EXISTS request_children_from_extracts
TO request_children
AS SELECT request_id, id, 'extracts' AS source, created_at
FROM extracts;

CREATE MATERIALIZED VIEW IF NOT EXISTS request_children_from_maps
TO request_children
AS SELECT request_id, id, 'maps' AS source, created_at
FROM maps;

CREATE MATERIALIZED VIEW IF NOT EXISTS request_children_from_llmstxts
TO request_children
AS SELECT request_id, id, 'llmstxts' AS source, created_at
FROM llmstxts;

CREATE MATERIALIZED VIEW IF NOT EXISTS request_children_from_deep_researches
TO request_children
AS SELECT request_id, id, 'deep_researches' AS source, created_at
FROM deep_researches;

-- Backfill: the last 8 days of children (24 hours of cleanup delay, plus
-- headroom for retried jobs and long crawls). Run after the views exist.
INSERT INTO request_children
SELECT request_id, id, 'scrapes' AS source, created_at
FROM scrapes
WHERE created_at >= now() - INTERVAL 8 DAY;
INSERT INTO request_children
SELECT request_id, id, 'searches' AS source, created_at
FROM searches
WHERE created_at >= now() - INTERVAL 8 DAY;
INSERT INTO request_children
SELECT request_id, id, 'extracts' AS source, created_at
FROM extracts
WHERE created_at >= now() - INTERVAL 8 DAY;
INSERT INTO request_children
SELECT request_id, id, 'maps' AS source, created_at
FROM maps
WHERE created_at >= now() - INTERVAL 8 DAY;
INSERT INTO request_children
SELECT request_id, id, 'llmstxts' AS source, created_at
FROM llmstxts
WHERE created_at >= now() - INTERVAL 8 DAY;
INSERT INTO request_children
SELECT request_id, id, 'deep_researches' AS source, created_at
FROM deep_researches
WHERE created_at >= now() - INTERVAL 8 DAY;
