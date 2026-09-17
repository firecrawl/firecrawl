-- Lookups that know a job id or a request id but not the team.
--
-- The ClickPipes-fed tables (`requests`, `scrapes`, ...) are sorted by
-- (team_id, id). Every API read carries the team and stays a primary-key read.
-- Three readers do not know the team up front and used to rely on the PeerDB
-- mirrors (`public_requests`, `public_scrapes`), which were sorted by id:
--
--   * firebill reconciliation: request by id, billable scrapes in a uuidv7 id
--     window, request rows for a list of ids;
--   * the dashboard: "which request produced this scrape id", crawl error
--     counts and search scrape credits by request_id;
--   * the exporter: every successful scrape of a crawl by request_id.
--
-- These tables are the replacement index. Materialized views fill them on
-- every insert; history is backfilled once with 0002_by_id_views_backfill.sh.
-- Every row is unique on its sorting key, so ReplacingMergeTree collapses the
-- exact duplicates a redelivered job row or an overlapping backfill can leave
-- behind. Point lookups tolerate a pre-merge duplicate; readers that count or
-- sum read with FINAL or DISTINCT.
--
-- ClickHouse compares UUIDs by their two 64-bit halves in swapped order, so
-- `ORDER BY id` is a stable order for point lookups and paging, NOT the
-- chronological order a uuidv7 range in PostgreSQL gave. Time windows use
-- `scrapes_by_time`, sorted by created_at.

-- requests by id: everything a by-id reader has needed so far.
CREATE TABLE IF NOT EXISTS requests_by_id
(
    id UUID,
    team_id UUID,
    kind LowCardinality(String),
    api_version String,
    created_at DateTime64(9),
    origin String,
    integration Nullable(String),
    target_hint String,
    api_key_id Nullable(Int64),
    external_request_id Nullable(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY id
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS requests_by_id_mv
TO requests_by_id
AS SELECT
    id,
    team_id,
    kind,
    api_version,
    created_at,
    origin,
    integration,
    target_hint,
    api_key_id,
    external_request_id
FROM requests;

-- scrapes by id: the dashboard's scrape-id search ("which request produced
-- this scrape id").
CREATE TABLE IF NOT EXISTS scrapes_by_id
(
    id UUID,
    request_id UUID,
    team_id UUID,
    is_successful Bool,
    credits_cost Int32,
    created_at DateTime64(9)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY id
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS scrapes_by_id_mv
TO scrapes_by_id
AS SELECT id, request_id, team_id, is_successful, credits_cost, created_at
FROM scrapes;

-- scrapes by request: the children of a crawl, batch scrape or search.
-- `is_real_error` mirrors the MATERIALIZED column the dashboard relied on in
-- `public_scrapes`: a failure that is not one of the crawler's own scope
-- rejections (include/exclude paths, depth limits, raced redirects).
CREATE TABLE IF NOT EXISTS scrapes_by_request
(
    request_id UUID,
    id UUID,
    team_id UUID,
    is_successful Bool,
    is_real_error UInt8,
    credits_cost Int32,
    created_at DateTime64(9)
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (request_id, id)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS scrapes_by_request_mv
TO scrapes_by_request
AS SELECT
    request_id,
    id,
    team_id,
    is_successful,
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
    credits_cost,
    created_at
FROM scrapes;

-- scrapes by time: firebill's reconciliation enumerates the completed,
-- positive-credit scrapes of a time window. The window used to be a uuidv7 id
-- range on a PostgreSQL table sorted by id; here it is a created_at range on a
-- table sorted by created_at, paged by (created_at, id).
CREATE TABLE IF NOT EXISTS scrapes_by_time
(
    created_at DateTime64(9),
    id UUID,
    request_id UUID,
    team_id UUID,
    is_successful Bool,
    credits_cost Int32
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (created_at, id)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS scrapes_by_time_mv
TO scrapes_by_time
AS SELECT created_at, id, request_id, team_id, is_successful, credits_cost
FROM scrapes;
