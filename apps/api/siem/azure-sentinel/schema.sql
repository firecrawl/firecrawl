CREATE TABLE IF NOT EXISTS public.siem_audit_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  destination jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.siem_audit_config FROM anon, authenticated;
