CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Checkpoint tuning: spread I/O to reduce stalls during heavy WAL activity
-- These settings help prevent prefetch queries from returning 0 jobs during checkpoints

-- Checkpoint settings: reduce frequency and spread I/O
ALTER SYSTEM SET checkpoint_completion_target = 0.9;  -- Spread checkpoint I/O over 90% of interval
ALTER SYSTEM SET checkpoint_timeout = '15min';         -- Longer intervals between time-based checkpoints
ALTER SYSTEM SET max_wal_size = '16GB';                -- Much larger WAL before forced checkpoint (was 4GB)
ALTER SYSTEM SET min_wal_size = '4GB';                 -- Keep WAL pre-allocated to avoid allocation stalls

-- Aggressive background writer: pre-flush dirty pages to reduce checkpoint burst
ALTER SYSTEM SET bgwriter_lru_maxpages = 1000;         -- Flush up to 1000 pages per round (was 500)
ALTER SYSTEM SET bgwriter_lru_multiplier = 4.0;        -- More aggressive dirty page estimation
ALTER SYSTEM SET bgwriter_delay = '50ms';              -- Run twice as often (was 100ms)
ALTER SYSTEM SET bgwriter_flush_after = '512kB';       -- Force OS flush after 512kB written

-- I/O concurrency for SSD/cloud storage (hyperdisk)
ALTER SYSTEM SET effective_io_concurrency = 200;       -- Parallel I/O operations for prefetch
ALTER SYSTEM SET maintenance_io_concurrency = 100;     -- I/O concurrency for maintenance ops

-- WAL settings for better write performance
ALTER SYSTEM SET wal_buffers = '64MB';                 -- Larger WAL buffer (default is too small)
ALTER SYSTEM SET wal_writer_delay = '10ms';            -- Flush WAL more frequently to avoid bursts
ALTER SYSTEM SET wal_writer_flush_after = '1MB';       -- Flush after 1MB of WAL

-- Reduce fsync overhead
ALTER SYSTEM SET commit_delay = 10;                    -- Microseconds to wait for group commit
ALTER SYSTEM SET commit_siblings = 5;                  -- Min concurrent transactions for commit_delay

SELECT pg_reload_conf();

CREATE SCHEMA IF NOT EXISTS nuq;

DO $$ BEGIN
  CREATE TYPE nuq.job_status AS ENUM ('queued', 'active', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE nuq.group_status AS ENUM ('active', 'completed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS nuq.queue_scrape (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status nuq.job_status NOT NULL DEFAULT 'queued'::nuq.job_status,
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  priority int NOT NULL DEFAULT 0,
  lock uuid,
  locked_at timestamp with time zone,
  stalls integer,
  finished_at timestamp with time zone,
  listen_channel_id text, -- for listenable jobs over rabbitmq
  returnvalue jsonb, -- only for selfhost
  failedreason text, -- only for selfhost
  owner_id uuid,
  group_id uuid,
  CONSTRAINT queue_scrape_pkey PRIMARY KEY (id)
);

ALTER TABLE nuq.queue_scrape
SET (autovacuum_vacuum_scale_factor = 0.01,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_vacuum_cost_limit = 10000,
     autovacuum_vacuum_cost_delay = 0);

CREATE INDEX IF NOT EXISTS queue_scrape_active_locked_at_idx ON nuq.queue_scrape USING btree (locked_at) WHERE (status = 'active'::nuq.job_status);
-- Authoritative per-owner drain probe for PG/FDB generation transitions.
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_owner_live_idx ON nuq.queue_scrape (owner_id) WHERE status IN ('queued'::nuq.job_status, 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_optimal_2_idx ON nuq.queue_scrape (priority ASC, created_at ASC, id) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_failed_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'failed'::nuq.job_status);

-- Predicate-matching partial indexes for the standalone (group_id IS NULL)
-- cleaners. In production virtually every row has a group_id, so these
-- indexes stay tiny and turn the standalone cleaners into fast no-ops instead
-- of seq scans over the whole 18M-row table.
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_completed_standalone_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'completed'::nuq.job_status AND group_id IS NULL);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_failed_standalone_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'failed'::nuq.job_status AND group_id IS NULL);

-- Plain group_id index for the cascading DELETE in nuq_group_crawl_clean.
-- The other partial (group_id, ...) indexes are all filtered by mode or status
-- so DELETE WHERE group_id IN (...) seq-scans the whole 18M-row table without
-- this. EXPLAIN confirmed ~7s/100 group_ids before adding this.
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_id_idx ON nuq.queue_scrape (group_id) WHERE group_id IS NOT NULL;

-- Indexes for crawl-status.ts queries
-- For getGroupAnyJob: query by group_id, owner_id, and data->>'mode' = 'single_urls'
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_owner_mode_idx ON nuq.queue_scrape (group_id, owner_id) WHERE ((data->>'mode') = 'single_urls');

-- For getGroupNumericStats: query by group_id and data->>'mode', grouped by status
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_mode_status_idx ON nuq.queue_scrape (group_id, status) WHERE ((data->>'mode') = 'single_urls');

-- For getCrawlJobsForListing: query by group_id, status='completed', data->>'mode', ordered by finished_at, created_at
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_completed_listing_idx ON nuq.queue_scrape (group_id, finished_at ASC, created_at ASC) WHERE (status = 'completed'::nuq.job_status AND (data->>'mode') = 'single_urls');

-- For group finish cron
CREATE INDEX IF NOT EXISTS idx_queue_scrape_group_status ON nuq.queue_scrape (group_id, status) WHERE status IN ('active', 'queued');

CREATE TABLE IF NOT EXISTS nuq.queue_scrape_backlog (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  priority int NOT NULL DEFAULT 0,
  listen_channel_id text, -- for listenable jobs over rabbitmq
  owner_id uuid,
  group_id uuid,
  times_out_at timestamptz,
  CONSTRAINT queue_scrape_backlog_pkey PRIMARY KEY (id)
);

-- For getBackloggedJobIDsOfOwner: query backlog by owner_id
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_backlog_owner_id_idx ON nuq.queue_scrape_backlog (owner_id);

-- For getGroupNumericStats backlog query: query by group_id and data->>'mode' on backlog table
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_backlog_group_mode_idx ON nuq.queue_scrape_backlog (group_id) WHERE ((data->>'mode') = 'single_urls');

-- For nuq_queue_scrape_backlog_reaper: avoid seq scan over the entire backlog every minute
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_backlog_times_out_at_idx ON nuq.queue_scrape_backlog (times_out_at);

SELECT cron.schedule('nuq_queue_scrape_clean_completed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'completed'::nuq.job_status AND nuq.queue_scrape.created_at < now() - interval '1 hour' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_scrape_clean_failed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'failed'::nuq.job_status AND nuq.queue_scrape.created_at < now() - interval '6 hours' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_scrape_lock_reaper', '15 seconds', $$
  UPDATE nuq.queue_scrape SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute' AND nuq.queue_scrape.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_scrape.stalls, 0) < 9;
  WITH stallfail AS (UPDATE nuq.queue_scrape SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute' AND nuq.queue_scrape.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_scrape.stalls, 0) >= 9 RETURNING id)
  SELECT pg_notify('nuq.queue_scrape', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

SELECT cron.schedule('nuq_queue_scrape_backlog_reaper', '* * * * *', $$
  SET statement_timeout = '50s';
  DELETE FROM nuq.queue_scrape_backlog
  WHERE nuq.queue_scrape_backlog.times_out_at < now();
$$);

-- Per-index REINDEX CONCURRENTLY, spread across the global low-traffic window
-- (02:00-06:20 UTC). REINDEX INDEX takes a ShareUpdateExclusiveLock only on
-- the target index, not the whole table.
--
-- Note: REINDEX CONCURRENTLY cannot run inside a transaction block, and pg_cron
-- wraps multi-statement commands in an implicit transaction. So each cron body
-- must be a single REINDEX statement -- statement_timeout cannot be set
-- inline. Stuck reindexes are caught by nuq_maintenance_watchdog below.
SELECT cron.schedule('nuq_reindex_queue_scrape_pkey',                   '0 2 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.queue_scrape_pkey;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_active_locked_at',       '20 2 * * *', $$REINDEX INDEX CONCURRENTLY nuq.queue_scrape_active_locked_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_queued_optimal_2',       '40 2 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_queued_optimal_2_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_failed_created_at',      '0 3 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_failed_created_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_group_owner_mode',       '40 3 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_group_owner_mode_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_group_mode_status',      '0 4 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_group_mode_status_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_group_completed_listing','20 4 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_group_completed_listing_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_group_status',           '40 4 * * *', $$REINDEX INDEX CONCURRENTLY nuq.idx_queue_scrape_group_status;$$);

SELECT cron.schedule('nuq_reindex_queue_scrape_backlog_pkey',           '0 5 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.queue_scrape_backlog_pkey;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_backlog_owner_id',       '20 5 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_backlog_owner_id_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_backlog_group_mode',     '40 5 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_backlog_group_mode_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_backlog_group_id',       '0 6 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.idx_queue_scrape_backlog_group_id;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_backlog_times_out_at',   '20 6 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_backlog_times_out_at_idx;$$);

SELECT cron.schedule('nuq_reindex_queue_scrape_completed_standalone',   '40 6 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_completed_standalone_created_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_failed_standalone',      '40 8 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_failed_standalone_created_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_scrape_group_id',               '40 9 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_scrape_group_id_idx;$$);

-- Watchdog: cancel any nuq REINDEX CONCURRENTLY that has been running > 18 min.
-- Acts as the safety net since statement_timeout cannot be set inline with
-- REINDEX CONCURRENTLY. Slots are 20 min apart, so the watchdog must run
-- frequently enough that a stuck job is killed before the next slot fires.
-- Cadence (1 min) + threshold (18 min) caps actual reindex runtime at ~19 min,
-- strictly under the 20 min cadence.
SELECT cron.schedule('nuq_maintenance_watchdog', '* * * * *', $$
  SELECT pg_cancel_backend(pid)
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
    AND query ILIKE 'REINDEX INDEX CONCURRENTLY nuq.%'
    AND now() - query_start > interval '18 minutes';
$$);

CREATE TABLE IF NOT EXISTS nuq.queue_crawl_finished (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status nuq.job_status NOT NULL DEFAULT 'queued'::nuq.job_status,
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  priority int NOT NULL DEFAULT 0,
  lock uuid,
  locked_at timestamp with time zone,
  stalls integer,
  finished_at timestamp with time zone,
  listen_channel_id text, -- for listenable jobs over rabbitmq
  returnvalue jsonb, -- only for selfhost
  failedreason text, -- only for selfhost
  owner_id uuid,
  group_id uuid,
  CONSTRAINT queue_crawl_finished_pkey PRIMARY KEY (id)
);

ALTER TABLE nuq.queue_crawl_finished
SET (autovacuum_vacuum_scale_factor = 0.01,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_vacuum_cost_limit = 10000,
     autovacuum_vacuum_cost_delay = 0);

CREATE INDEX IF NOT EXISTS queue_crawl_finished_active_locked_at_idx ON nuq.queue_crawl_finished USING btree (locked_at) WHERE (status = 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_owner_live_idx ON nuq.queue_crawl_finished (owner_id) WHERE status IN ('queued'::nuq.job_status, 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_queued_optimal_2_idx ON nuq.queue_crawl_finished (priority ASC, created_at ASC, id) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_failed_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'failed'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_completed_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'completed'::nuq.job_status);

-- Predicate-matching partial indexes for the standalone (group_id IS NULL)
-- cleaners; see note on queue_scrape above.
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_completed_standalone_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'completed'::nuq.job_status AND group_id IS NULL);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_failed_standalone_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'failed'::nuq.job_status AND group_id IS NULL);

-- Plain group_id index for the cascading DELETE in nuq_group_crawl_clean.
-- See note on queue_scrape above.
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_group_id_idx ON nuq.queue_crawl_finished (group_id) WHERE group_id IS NOT NULL;

SELECT cron.schedule('nuq_queue_crawl_finished_clean_completed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_crawl_finished WHERE nuq.queue_crawl_finished.status = 'completed'::nuq.job_status AND nuq.queue_crawl_finished.created_at < now() - interval '1 hour' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_crawl_finished_clean_failed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_crawl_finished WHERE nuq.queue_crawl_finished.status = 'failed'::nuq.job_status AND nuq.queue_crawl_finished.created_at < now() - interval '6 hours' AND group_id IS NULL;
$$);

SELECT cron.schedule('nuq_queue_crawl_finished_lock_reaper', '15 seconds', $$
  UPDATE nuq.queue_crawl_finished SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_crawl_finished.locked_at <= now() - interval '1 minute' AND nuq.queue_crawl_finished.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_crawl_finished.stalls, 0) < 9;
  WITH stallfail AS (UPDATE nuq.queue_crawl_finished SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1 WHERE nuq.queue_crawl_finished.locked_at <= now() - interval '1 minute' AND nuq.queue_crawl_finished.status = 'active'::nuq.job_status AND COALESCE(nuq.queue_crawl_finished.stalls, 0) >= 9 RETURNING id)
  SELECT pg_notify('nuq.queue_crawl_finished', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

-- Per-index REINDEX CONCURRENTLY for queue_crawl_finished. See note above on
-- why these are single-statement (no inline statement_timeout).
SELECT cron.schedule('nuq_reindex_queue_crawl_finished_pkey',                 '0 7 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.queue_crawl_finished_pkey;$$);
SELECT cron.schedule('nuq_reindex_queue_crawl_finished_active_locked_at',     '20 7 * * *', $$REINDEX INDEX CONCURRENTLY nuq.queue_crawl_finished_active_locked_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_crawl_finished_queued_optimal_2',     '40 7 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_crawl_finished_queued_optimal_2_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_crawl_finished_failed_created_at',    '0 8 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_crawl_finished_failed_created_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_crawl_finished_completed_created_at', '20 8 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_crawl_finished_completed_created_at_idx;$$);

SELECT cron.schedule('nuq_reindex_queue_crawl_finished_completed_standalone', '0 9 * * *',   $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_crawl_finished_completed_standalone_created_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_crawl_finished_failed_standalone',    '20 9 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_crawl_finished_failed_standalone_created_at_idx;$$);
SELECT cron.schedule('nuq_reindex_queue_crawl_finished_group_id',             '0 10 * * *',  $$REINDEX INDEX CONCURRENTLY nuq.nuq_queue_crawl_finished_group_id_idx;$$);
SELECT cron.schedule('nuq_reindex_group_crawl_completed_expires_at',          '20 10 * * *', $$REINDEX INDEX CONCURRENTLY nuq.nuq_group_crawl_completed_expires_at_idx;$$);

CREATE TABLE IF NOT EXISTS nuq.group_crawl (
  id uuid NOT NULL,
  status nuq.group_status NOT NULL DEFAULT 'active'::nuq.group_status,
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_id uuid NOT NULL,
  ttl int8 NOT NULL DEFAULT 86400000,
  expires_at timestamptz,
  CONSTRAINT group_crawl_pkey PRIMARY KEY (id)
);

-- Index for group finish cron to find active groups
CREATE INDEX IF NOT EXISTS idx_group_crawl_status ON nuq.group_crawl (status) WHERE status = 'active'::nuq.group_status;
CREATE INDEX IF NOT EXISTS nuq_group_crawl_owner_live_idx ON nuq.group_crawl (owner_id) WHERE status = 'active'::nuq.group_status;

-- Index for nuq_group_crawl_clean victim selection. The status='active'
-- partial index above is the opposite predicate, so without this the cleaner
-- seq-scans the whole group_crawl table every 5 min.
CREATE INDEX IF NOT EXISTS nuq_group_crawl_completed_expires_at_idx ON nuq.group_crawl (expires_at) WHERE status = 'completed'::nuq.group_status;

-- Index for backlog group_id lookups
CREATE INDEX IF NOT EXISTS idx_queue_scrape_backlog_group_id ON nuq.queue_scrape_backlog (group_id);

SELECT cron.schedule('nuq_group_crawl_finished', '15 seconds', $$
  WITH finished_groups AS (
    UPDATE nuq.group_crawl
    SET status = 'completed'::nuq.group_status,
        expires_at = now() + MAKE_INTERVAL(secs => nuq.group_crawl.ttl / 1000)
    WHERE status = 'active'::nuq.group_status
      AND NOT EXISTS (
        SELECT 1 FROM nuq.queue_scrape
        WHERE nuq.queue_scrape.status IN ('active', 'queued')
          AND nuq.queue_scrape.group_id = nuq.group_crawl.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM nuq.queue_scrape_backlog
        WHERE nuq.queue_scrape_backlog.group_id = nuq.group_crawl.id
      )
    RETURNING id, owner_id
  )
  INSERT INTO nuq.queue_crawl_finished (data, owner_id, group_id)
  SELECT '{}'::jsonb, finished_groups.owner_id, finished_groups.id
  FROM finished_groups;
$$);

-- Batched group cleanup: small LIMIT, fast cadence. queue_scrape has 12
-- indexes plus scattered heap pages, so per-row delete cost (~86 rows/s
-- measured) dominates regardless of how the work is grouped. Bigger batches
-- just made one heavy outlier group (max 8495 jobs vs p50 9) blow the
-- statement_timeout. 500 groups/min: throughput is 30k/hr against a steady
-- arrival of ~19k/hr, normal runs land in ~10s, worst case with a heavy
-- group in the batch ~140s -- well under the 90s timeout, and if we ever do
-- hit it the next minute's tick takes another swing rather than holding a
-- 4min transaction. SKIP LOCKED keeps overlapping ticks from fighting.
SELECT cron.schedule('nuq_group_crawl_clean', '* * * * *', $$
  SET statement_timeout = '90s';
  WITH victims AS (
    SELECT id FROM nuq.group_crawl
    WHERE status = 'completed'::nuq.group_status
      AND expires_at < now()
    ORDER BY expires_at
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  ), cleaned_groups AS (
    DELETE FROM nuq.group_crawl
    WHERE id IN (SELECT id FROM victims)
    RETURNING id
  ), cleaned_jobs_queue_scrape AS (
    DELETE FROM nuq.queue_scrape
    WHERE nuq.queue_scrape.group_id IN (SELECT id FROM cleaned_groups)
  ), cleaned_jobs_queue_scrape_backlog AS (
    DELETE FROM nuq.queue_scrape_backlog
    WHERE nuq.queue_scrape_backlog.group_id IN (SELECT id FROM cleaned_groups)
  ), cleaned_jobs_crawl_finished AS (
    DELETE FROM nuq.queue_crawl_finished
    WHERE nuq.queue_crawl_finished.group_id IN (SELECT id FROM cleaned_groups)
  )
  SELECT 1;
$$);

-- pg_cron does not auto-prune cron.job_run_details; with sub-minute crons it
-- grows unbounded and seq-scans get unusable. Keep the last 24h.
SELECT cron.schedule('cron_job_run_details_prune', '0 * * * *', $$
  DELETE FROM cron.job_run_details WHERE start_time < now() - interval '24 hours';
$$);
