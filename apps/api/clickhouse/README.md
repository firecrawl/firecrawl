# ClickHouse schema

Statements the API depends on but does not create. Tables fed by ClickPipes
from the Pub/Sub log topics (`requests`, `scrapes`, ...) are created by
ClickPipes itself and are not listed here. Everything else the API reads or
writes in the analytics ClickHouse service lives in this directory as a
numbered file.

Apply each file once, in order, with a user that can create tables and
materialized views. Files are idempotent (`IF NOT EXISTS`).

| File                        | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `0001_request_children.sql` | Result blob ids per request, for ZDR cleanup. |
