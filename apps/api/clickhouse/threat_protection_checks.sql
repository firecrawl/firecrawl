-- Security event log for threat protection domain checks (one row per
-- decision, allowed and blocked). Written by trackThreatProtectionCheck()
-- in apps/api/src/lib/tracking.ts; read by the
-- GET /v2/team/threat-protection/logs export API.
--
-- Retention rules:
--  * zero-data-retention requests: url is stored as '' (the domain is kept).
--  * the raw provider payload is never stored here.
CREATE TABLE IF NOT EXISTS threat_protection_checks
(
    event_time DateTime64(3),
    -- Random UUID generated at emit time; cursor-pagination tiebreaker for
    -- the log export API.
    event_id UUID,
    team_id String DEFAULT '',
    org_id String DEFAULT '',
    request_id String DEFAULT '',
    job_id String DEFAULT '',
    crawl_id String DEFAULT '',
    endpoint LowCardinality(String) DEFAULT '',
    -- Empty for zero-data-retention requests and for checks not tied to a
    -- single URL (e.g. deduped crawl-discovery domain checks).
    url String DEFAULT '',
    url_domain String,
    mode LowCardinality(String),
    provider LowCardinality(String) DEFAULT '',
    -- NULL = the provider was not consulted or gave no score (0 is a valid
    -- score, so a sentinel default would be ambiguous).
    risk_score Nullable(UInt8),
    categories Array(String),
    -- NULL = unknown (normal mode never has it).
    domain_age_days Nullable(Int32),
    country_code LowCardinality(String) DEFAULT '',
    decision LowCardinality(String), -- 'allowed' | 'blocked'
    rule LowCardinality(String),
    provider_consulted UInt8,
    from_cache UInt8,
    origin LowCardinality(String) DEFAULT '',
    zero_data_retention UInt8 DEFAULT 0
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (org_id, event_time);
