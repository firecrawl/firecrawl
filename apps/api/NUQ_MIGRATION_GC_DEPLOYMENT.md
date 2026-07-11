# NuQ migration GC deployment contract

This repository builds the `nuq-reconciler-worker`; it does not own the production Helm release. The infrastructure change that deploys this image **must** supply the following HPA contract before any 45-day migration-retention cohort becomes due.

## Required replica/HPA settings

- `minReplicas: 2` (production must not remain at the current single replica).
- `maxReplicas: 32`. GC has 32 globally leased FDB partitions per category, so replicas above 32 cannot add useful FDB concurrency.
- Scale on `nuq_migration_gc_due_backlog` using an external/object metric target of **100 due items per replica**. The adapter must take the **maximum**, not sum, of this global gauge across worker pods.
- Also scale on `nuq_migration_gc_oldest_overdue_seconds` with a target of **300 seconds**. The adapter must use the **maximum oldest age across pods** (never a sum or average). Kubernetes chooses the largest replica recommendation from the backlog and age metrics.
- Use a fast scale-up policy (no scale-up stabilization; at least 100% or 8 pods per minute) and a conservative scale-down window of at least 10 minutes.
- Keep the reconciler's normal CPU/memory safeguards. Backlog-aware cadence does not skip normal concurrency reconciliation: every retry performs both bounded GC and the ordinary team pass.

The first production deployment must raise the replica floor above one and verify the external metrics/HPA recommendations before the 45-day due cliff. Do not rely on retention alone to smooth that first cohort.

## Metric contract

All GC metrics are served by the `nuq-reconciler-worker` `/metrics` endpoint and have a bounded `category` label:

- `terminal_pin`
- `control_history`
- `closed_generation`
- `redis_cleanup`

Capacity metrics:

- `nuq_migration_gc_due_backlog{category}`: exact count currently due.
- `nuq_migration_gc_oldest_overdue_seconds{category}`: exact oldest due age, or zero when idle.

Operational counters:

- `nuq_migration_gc_runs_total{category}`
- `nuq_migration_gc_pages_total{category}`
- `nuq_migration_gc_items_total{category,outcome}` (`processed`, `removed`, `retained`, `stale`)
- `nuq_migration_gc_errors_total{category}`
- `nuq_migration_gc_run_duration_seconds`
- `nuq_migration_gc_processed_items_per_second{category}`

Alert on any sustained error increase, oldest overdue age above 15 minutes, or backlog growth while replicas are below 32. Add a distinct critical alert for sustained backlog growth when the HPA is already at `maxReplicas=32`; at that point this is a page-latency/storage-dependency incident, not an HPA problem.

FDB counts are maintained transactionally in 32 sharded timestamp trees and oldest timestamps use one limit-1 read from each index partition; collection performs no global range scan. Redis uses native `ZCARD`/`ZCOUNT` and a limit-1 oldest-score read.

## Runtime tuning

Safe validated defaults:

- `NUQ_MIGRATION_GC_PAGE_LIMIT=100`
- `NUQ_MIGRATION_GC_MAX_PAGES=128`
- `NUQ_MIGRATION_GC_WORK_BUDGET_MS=20000`
- `NUQ_RECONCILER_BACKLOG_RETRY_MS=5000`
- `NUQ_RECONCILER_IDLE_INTERVAL_MS=60000`

A page never exceeds 100 items. The independent page and wall-clock caps bound shutdown and reserve time for normal reconciliation. Every storage transaction and external authority probe also has a 10-second operation bound, and the wall budget aborts page work between individual items. Retained rows are rescheduled one hour into the future and therefore do not cause a hot retry loop.

## Isolated page-loop capacity evidence

The deterministic isolated-service benchmark in `nuq-router-gc.test.ts` uses a 10,000-item due cohort, a representative 20 ms storage-page latency, one replica, 100-item pages, and the production `maxPages=128` contract. Its acceptance target is **at least 2,000 items/second**, comfortably above the documented planning arrival target of **1,000 due items/second per replica** while still asserting that no page exceeds 100 items. Production capacity must additionally be verified from `nuq_migration_gc_processed_items_per_second` and run-duration histograms because PG/Redis/FDB latency, rather than scheduler overhead, is the expected limiter.

## Infrastructure refresh note

The final infrastructure refresh for #195 must replace the fixed `nuqReconciler.replicas=1` setting with the HPA above (or an equivalent external-metrics implementation), with a production minimum of two and maximum of 32. This API repository intentionally does not add a Helm example because the chart is owned by the infrastructure repository.
