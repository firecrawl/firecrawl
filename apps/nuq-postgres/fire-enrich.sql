-- fire-enrich tables, mounted alongside nuq.sql in the postgres initdb run.
-- Lives in the public schema; nuq stays in nuq.* — no overlap.

CREATE TABLE IF NOT EXISTS public.principals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                  text        NOT NULL,
  token_hash             text        NOT NULL UNIQUE,
  token_salt             text        NOT NULL,
  token_prefix           text        NOT NULL,
  byok_firecrawl_key     text,
  byok_openai_key        text,
  quota_firecrawl_month  jsonb,
  quota_openai_month     jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  revoked_at             timestamptz
);

CREATE INDEX IF NOT EXISTS principals_token_hash_idx ON public.principals (token_hash);

CREATE TABLE IF NOT EXISTS public.usage_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid        NOT NULL REFERENCES public.principals (id) ON DELETE CASCADE,
  scope         text        NOT NULL CHECK (scope IN ('firecrawl', 'openai')),
  op            text        NOT NULL,
  source        text        NOT NULL CHECK (source IN ('byok', 'pooled')),
  ok            integer     NOT NULL,
  units         integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_principal_time_idx
  ON public.usage_events (principal_id, created_at);
