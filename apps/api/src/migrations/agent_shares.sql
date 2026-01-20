-- Migration: Create agent_shares table for shareable agent session links
-- Run this migration against your Supabase database

CREATE TABLE IF NOT EXISTS agent_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  team_id uuid NOT NULL,
  share_token varchar(64) NOT NULL UNIQUE,
  access_mode varchar(16) NOT NULL DEFAULT 'public',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  view_count integer NOT NULL DEFAULT 0,
  created_by_user_id uuid,

  CONSTRAINT valid_access_mode CHECK (access_mode IN ('public', 'team'))
);

-- Index for looking up active shares by token (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_agent_shares_token ON agent_shares(share_token) WHERE is_active = true;

-- Index for listing shares by agent
CREATE INDEX IF NOT EXISTS idx_agent_shares_agent_id ON agent_shares(agent_id);

-- Index for team-based queries
CREATE INDEX IF NOT EXISTS idx_agent_shares_team_id ON agent_shares(team_id);

-- RPC function for atomically incrementing view count
CREATE OR REPLACE FUNCTION increment_share_view_count(p_share_token varchar(64))
RETURNS void
LANGUAGE sql
AS $$
  UPDATE agent_shares
  SET view_count = view_count + 1
  WHERE share_token = p_share_token
    AND is_active = true;
$$;

-- Grant appropriate permissions
-- Adjust these based on your Supabase RLS policies
-- GRANT SELECT, INSERT, UPDATE ON agent_shares TO authenticated;
-- GRANT SELECT ON agent_shares TO anon;
-- GRANT EXECUTE ON FUNCTION increment_share_view_count TO authenticated;
-- GRANT EXECUTE ON FUNCTION increment_share_view_count TO anon;
