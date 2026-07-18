-- Train 2 forward migration: accept the Anthropic search-only hosted MCP resource.
-- Keep the Train 1 table creation migration immutable for safe staged rollout.
BEGIN;

ALTER TABLE public.mcp_action_logs
  DROP CONSTRAINT IF EXISTS mcp_action_logs_resource_check;

ALTER TABLE public.mcp_action_logs
  ADD CONSTRAINT mcp_action_logs_resource_check CHECK (resource IN (
    'https://mcp.firecrawl.dev/v2/mcp',
    'https://mcp.firecrawl.dev/v2/mcp-oauth',
    'https://mcp.firecrawl.dev/v2/mcp-search'
  ));

COMMIT;
