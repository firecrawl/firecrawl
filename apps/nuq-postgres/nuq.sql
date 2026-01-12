CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

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
     autovacuum_vacuum_cost_limit = 2000,
     autovacuum_vacuum_cost_delay = 2);

CREATE INDEX IF NOT EXISTS queue_scrape_active_locked_at_idx ON nuq.queue_scrape USING btree (locked_at) WHERE (status = 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_optimal_2_idx ON nuq.queue_scrape (priority ASC, created_at ASC, id) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_failed_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'failed'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_completed_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'completed'::nuq.job_status);

-- Indexes for crawl-status.ts queries
-- For getGroupAnyJob: query by group_id, owner_id, and data->>'mode' = 'single_urls'
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_owner_mode_idx ON nuq.queue_scrape (group_id, owner_id) WHERE ((data->>'mode') = 'single_urls');

-- For getGroupNumericStats: query by group_id and data->>'mode', grouped by status
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_mode_status_idx ON nuq.queue_scrape (group_id, status) WHERE ((data->>'mode') = 'single_urls');

-- For getCrawlJobsForListing: query by group_id, status='completed', data->>'mode', ordered by finished_at, created_at
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_group_completed_listing_idx ON nuq.queue_scrape (group_id, finished_at ASC, created_at ASC) WHERE (status = 'completed'::nuq.job_status AND (data->>'mode') = 'single_urls');

-- For group finish cron (checking active/queued jobs)
CREATE INDEX IF NOT EXISTS idx_queue_scrape_group_status ON nuq.queue_scrape (group_id, status) WHERE status IN ('active', 'queued');

-- NOTE: The backlog table (queue_scrape_backlog) has been replaced by FoundationDB.
-- See migration 002_remove_backlog_for_fdb.sql for cleanup of existing installations.

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

-- NOTE: nuq_queue_scrape_backlog_reaper has been removed.
-- The backlog is now managed by FoundationDB with its own TTL handling.

SELECT cron.schedule('nuq_queue_scrape_reindex', '0 9 * * *', $$
  REINDEX TABLE CONCURRENTLY nuq.queue_scrape;
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
     autovacuum_vacuum_cost_limit = 2000,
     autovacuum_vacuum_cost_delay = 2);

CREATE INDEX IF NOT EXISTS queue_crawl_finished_active_locked_at_idx ON nuq.queue_crawl_finished USING btree (locked_at) WHERE (status = 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_queued_optimal_2_idx ON nuq.queue_crawl_finished (priority ASC, created_at ASC, id) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_failed_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'failed'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_crawl_finished_completed_created_at_idx ON nuq.queue_crawl_finished USING btree (created_at) WHERE (status = 'completed'::nuq.job_status);

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

SELECT cron.schedule('nuq_queue_crawl_finished_reindex', '0 9 * * *', $$
  REINDEX TABLE CONCURRENTLY nuq.queue_crawl_finished;
$$);

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

-- Index for backlog group_id lookups
-- NOTE: nuq_group_crawl_finished cron has been moved to the NuQ janitor worker.
-- The JS worker (nuq-janitor-worker.ts) checks both PostgreSQL queue
-- and FoundationDB backlog before marking a crawl as finished.

SELECT cron.schedule('nuq_group_crawl_clean', '*/5 * * * *', $$
  WITH cleaned_groups AS (
    DELETE FROM nuq.group_crawl
    WHERE nuq.group_crawl.status = 'completed'::nuq.group_status
      AND nuq.group_crawl.expires_at < now()
    RETURNING *
  ), cleaned_jobs_queue_scrape AS (
    DELETE FROM nuq.queue_scrape
    WHERE nuq.queue_scrape.group_id IN (SELECT id FROM cleaned_groups)
  ), cleaned_jobs_crawl_finished AS (
    DELETE FROM nuq.queue_crawl_finished
    WHERE nuq.queue_crawl_finished.group_id IN (SELECT id FROM cleaned_groups)
  )
  SELECT 1;
$$);
