-- This script runs first to create pg_cron extension in postgres database
-- pg_cron can only be created in the database specified in cron.database_name
-- which is set to 'firecrawl' in postgresql.conf

\c postgres
CREATE EXTENSION IF NOT EXISTS pg_cron;

\c firecrawl
CREATE EXTENSION IF NOT EXISTS pgcrypto;
