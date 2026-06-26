CREATE TABLE IF NOT EXISTS concurrency_logs
(
    created_at DateTime,
    team_id UUID,
    avg_concurrency UInt32,
    max_concurrency UInt32,
    aggregate_minutes UInt8 DEFAULT 10
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)
ORDER BY (team_id, created_at);
