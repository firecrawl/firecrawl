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
-- Run once against the analytics ClickHouse service. Deploy the cleaner change
-- that reads this table no earlier than 24 hours after these statements ran,
-- so every request due for cleanup has its children indexed.

CREATE TABLE IF NOT EXISTS request_children
(
    request_id UUID,
    id UUID,
    source LowCardinality(String),
    created_at DateTime64(9)
)
ENGINE = MergeTree
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
