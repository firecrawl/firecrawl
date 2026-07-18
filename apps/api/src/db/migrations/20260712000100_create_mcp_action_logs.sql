-- Deployment migration: apply explicitly before enabling MCP activity-log writes.
-- This intentionally fails if the table already exists with an unknown shape.
CREATE TABLE public.mcp_action_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  user_id uuid,
  api_key_id bigint,
  oauth_client_id text,
  auth_type text NOT NULL CHECK (auth_type IN ('oauth', 'api-key')),
  tool_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'error')),
  request_id uuid NOT NULL,
  client_name text,
  client_version text,
  error_class text,
  resource text NOT NULL CHECK (resource IN (
    'https://mcp.firecrawl.dev/v2/mcp',
    'https://mcp.firecrawl.dev/v2/mcp-oauth'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CONSTRAINT mcp_action_logs_metadata_lengths CHECK (
    char_length(oauth_client_id) <= 128
    AND char_length(tool_name) <= 128
    AND char_length(client_name) <= 128
    AND char_length(client_version) <= 128
    AND char_length(error_class) <= 128
  ),
  CONSTRAINT mcp_action_logs_auth_shape CHECK (
    (auth_type = 'api-key' AND api_key_id IS NOT NULL AND user_id IS NULL AND oauth_client_id IS NULL)
    OR
    (auth_type = 'oauth' AND user_id IS NOT NULL AND oauth_client_id IS NOT NULL)
  ),
  CONSTRAINT mcp_action_logs_team_request_unique UNIQUE (team_id, request_id)
);

CREATE INDEX IF NOT EXISTS mcp_action_logs_team_created_idx
  ON public.mcp_action_logs (team_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS mcp_action_logs_expires_idx
  ON public.mcp_action_logs (expires_at);
