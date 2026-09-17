# ClickHouse schema

Statements the API depends on but does not create. Tables fed by ClickPipes
from the Pub/Sub log topics (`requests`, `scrapes`, ...) are created by
ClickPipes itself and are not listed here. Everything else the API reads or
writes in the analytics ClickHouse service lives in this directory.

Apply each file once, numbered files in order, with a user that can create
tables and materialized views. Table and view statements are idempotent
(`IF NOT EXISTS`); a file's backfill INSERTs are meant to run once.

| File                        | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `concurrency_logs.sql`      | Concurrency limit events (`lib/cclog.ts`). Predates the numbering. |
| `0001_request_children.sql` | Result blob ids per request, for ZDR cleanup.                      |
| `0002_by_id_views.sql` | `requests_by_id`, `scrapes_by_id`, `scrapes_by_request`, `scrapes_by_time`: lookups that do not know the team (firebill, dashboard, exporter). |
| `0002_by_id_views_backfill.sh` | One-off history copy into the four tables above, month by month. |
