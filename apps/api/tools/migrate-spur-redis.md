# Spur Redis migration

The script copies only `spur_context:*`, `spur_context_failed:*`, and
`spur_lock:*` string keys. It uses SCAN and batches of at most 1,000 reads/writes,
with a small delay between batches. Memory use is bounded by a SCAN page and
batch. SCAN can return duplicates; reported matched counts are observations,
not a unique-key count.

Run from `apps/api`, with its dependencies installed. Set `SOURCE_REDIS_URL`
and `TARGET_REDIS_URL` to distinct Redis/Dragonfly servers, preferably through
loopback-only port forwards. Never point the application at the destination
before copying the existing cache.

```sh
node tools/migrate-spur-redis.mjs           # Read-only inventory
node tools/migrate-spur-redis.mjs --execute # Copy, preserving absolute expiration
node tools/migrate-spur-redis.mjs --verify  # Compare values and expiration times
```

A Lua read captures each value and expiration atomically. SET NX / PXAT keeps
existing destination values and original expiry times, including expiring lock
keys. Persistent keys remain persistent. Source keys are never deleted. No key
names, values, or endpoint credentials are logged. Wrong types and failed
commands abort the pass; a new run safely starts SCAN from zero.

After switching **all** application instances to `SPUR_REDIS_URL`, rerun the
copy to pick up late source writes, then verify. Writes and expirations during
SCAN can cause differences: verification is not a point-in-time snapshot.
Inspect differences before cleanup; do not overwrite newer destination values.
Keep source keys for rollback until cutover is verified. Any removal should be
a separate, reviewed operation. Take a destination snapshot after migration.

With no `SPUR_REDIS_URL`, Firecrawl retains its existing shared Redis behavior.
Once configured, a dedicated datastore failure fails open through the existing
Spur error handling, without falling back to an obsolete shared cache.

## Test

Start two empty, disposable local Dragonfly/Redis instances on ports 16389 and
16390, then run:

```sh
SPUR_MIGRATION_TEST=1 node --test tools/migrate-spur-redis.test.mjs
# Optional scale test:
SPUR_MIGRATION_TEST=1 SPUR_MIGRATION_TEST_KEYS=300000 node --test tools/migrate-spur-redis.test.mjs
```

Tests refuse non-empty instances and leave their synthetic keys behind. Destroy
and recreate the disposable instances before repeating the test.
