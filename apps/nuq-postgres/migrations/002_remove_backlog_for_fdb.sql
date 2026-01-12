-- Migration: Remove PostgreSQL backlog table and related crons
-- The backlog functionality has been moved to FoundationDB
--
-- This migration:
-- 1. Unschedules the backlog reaper cron
-- 2. Unschedules the group crawl finished cron (moved to JS worker)
-- 3. Drops the backlog table
-- 4. Updates the group cleanup cron to not reference backlog

-- Remove the backlog reaper cron
SELECT cron.unschedule('nuq_queue_scrape_backlog_reaper');

-- Remove the group crawl finished cron (now handled by JS worker)
SELECT cron.unschedule('nuq_group_crawl_finished');

-- Update the group cleanup cron to not reference backlog table
SELECT cron.unschedule('nuq_group_crawl_clean');

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

-- Drop the backlog table and its indexes
DROP INDEX IF EXISTS nuq.nuq_queue_scrape_backlog_group_mode_idx;
DROP INDEX IF EXISTS nuq.idx_queue_scrape_backlog_group_id;
DROP TABLE IF EXISTS nuq.queue_scrape_backlog;
