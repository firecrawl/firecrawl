-- One row per agent hint emitted on a v2 business response.
-- hint_id is the stable rule key from src/lib/agent-hints.ts, so the wording of
-- a hint can change without breaking a series. job_id is the id the same
-- response returned, which joins a hint to the calls the agent made next.
CREATE TABLE IF NOT EXISTS agent_hint_emissions
(
    emitted_at DateTime64(3),
    hint_id LowCardinality(String),
    endpoint LowCardinality(String),
    job_id String,
    team_id String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(emitted_at)
ORDER BY (hint_id, emitted_at);
