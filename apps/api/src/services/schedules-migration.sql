-- Migration: create schedules table for recurring scrape/crawl jobs
CREATE TABLE IF NOT EXISTS schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           text,
  cron           text NOT NULL,
  url            text NOT NULL,
  mode           text NOT NULL DEFAULT 'scrape' CHECK (mode IN ('scrape', 'crawl')),
  scrape_options jsonb,
  crawl_options  jsonb,
  webhook        jsonb,
  paused         boolean NOT NULL DEFAULT false,
  last_run_at    timestamptz,
  last_run_status text CHECK (last_run_status IN ('completed', 'failed')),
  last_result    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_team_id_idx ON schedules(team_id);
CREATE INDEX IF NOT EXISTS schedules_created_at_idx ON schedules(team_id, created_at DESC);

-- For environments where the table already exists, run this to add the last_result column:
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_result text;
