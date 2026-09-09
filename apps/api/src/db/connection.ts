import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "../config";
import { logger } from "../lib/logger";
import {
  keepPoolWarm,
  pickMaxLifetimeSeconds,
  resolveDbPoolOptions,
  type DbPoolName,
} from "./pool-profiles";

type DB = NodePgDatabase;

// Registry of every pool we create, for /metrics exposure.
const dbPools: { name: string; pool: Pool }[] = [];

// One lifetime for every pool in this process; randomized per process so
// recycling never lines up across the fleet (see pool-profiles.ts).
const poolMaxLifetimeSeconds = pickMaxLifetimeSeconds();

function makeDb(
  connectionString: string | undefined,
  applicationName: string,
  poolName: DbPoolName,
  { keepWarm = true }: { keepWarm?: boolean } = {},
): DB | null {
  if (!connectionString) {
    return null;
  }

  // Sizing comes from the deployment's DB_POOL_PROFILE (pool-profiles.ts).
  // Each process opens up to `max` client connections per pool against the
  // (transaction) pooler. Supabase pins pgbouncer's max_client_conn at 12000,
  // so the fleet-wide budget is `pods * max` per pool, and per-process pools
  // stay small: the transaction pooler multiplexes server connections, so a
  // large client pool buys little throughput but eats the global cap. `min`
  // keeps connections warm across traffic dips so a burst never has the whole
  // fleet re-opening connections at once.
  const options = resolveDbPoolOptions(
    config.DB_POOL_PROFILE,
    poolName,
    poolMaxLifetimeSeconds,
  );
  // A pool that is not kept warm keeps the profile's connect timeout,
  // lifetime and keepalive but drains like before (no floor, 10 s idle
  // eviction) so it never double-counts against the pooler's client budget.
  if (!keepWarm) {
    options.min = 0;
    options.idleTimeoutMillis = 10_000;
  }
  const pool = new Pool({
    connectionString,
    application_name: applicationName,
    max: options.max,
    min: options.min,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    maxLifetimeSeconds: options.maxLifetimeSeconds,
    keepAlive: true,
    keepAliveInitialDelayMillis: options.keepAliveInitialDelayMillis,
  });
  dbPools.push({ name: applicationName, pool });
  logger.info("Postgres pool configured", {
    module: "db",
    applicationName,
    profile: config.DB_POOL_PROFILE ?? "default",
    ...options,
  });
  pool.on("error", err =>
    logger.error("Error in idle Postgres client", {
      err,
      module: "db",
      applicationName,
    }),
  );

  let lastWarn = 0;
  pool.on("acquire", () => {
    const max = pool.options.max ?? 10;
    if (
      pool.waitingCount > 0 &&
      pool.totalCount >= max &&
      Date.now() - lastWarn > 1000
    ) {
      lastWarn = Date.now();
      logger.warn("Postgres pool exhausted, queries are queuing", {
        module: "db",
        applicationName,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max,
      });
    }
  });

  keepPoolWarm(pool, options.min, {
    initialDelayMs: Math.floor(Math.random() * 60_000),
    intervalMs: 5_000 + Math.floor(Math.random() * 2_000),
    onError: error =>
      logger.warn("Postgres pool warm-up connect failed", {
        module: "db",
        applicationName,
        error,
      }),
  });

  return drizzle({ client: pool });
}

/** Prometheus text-format gauges for every DB pool in this process. */
export function getDbPoolMetrics(): string {
  const lines: string[] = [
    "# HELP db_pool_waiting_count Number of queries queued waiting for a free connection in this pool",
    "# TYPE db_pool_waiting_count gauge",
  ];
  for (const { name, pool } of dbPools) {
    lines.push(
      `db_pool_waiting_count{application_name="${name}"} ${pool.waitingCount}`,
    );
  }
  lines.push(
    "# HELP db_pool_idle_count Number of idle connections in this pool",
    "# TYPE db_pool_idle_count gauge",
  );
  for (const { name, pool } of dbPools) {
    lines.push(
      `db_pool_idle_count{application_name="${name}"} ${pool.idleCount}`,
    );
  }
  lines.push(
    "# HELP db_pool_total_count Number of connections currently open in this pool",
    "# TYPE db_pool_total_count gauge",
  );
  for (const { name, pool } of dbPools) {
    lines.push(
      `db_pool_total_count{application_name="${name}"} ${pool.totalCount}`,
    );
  }
  lines.push(
    "# HELP db_pool_max_count Configured maximum connections for this pool",
    "# TYPE db_pool_max_count gauge",
  );
  for (const { name, pool } of dbPools) {
    lines.push(
      `db_pool_max_count{application_name="${name}"} ${pool.options.max ?? 20}`,
    );
  }
  lines.push(
    "# HELP db_pool_min_count Configured minimum (kept-warm) connections for this pool",
    "# TYPE db_pool_min_count gauge",
  );
  for (const { name, pool } of dbPools) {
    lines.push(
      `db_pool_min_count{application_name="${name}"} ${pool.options.min ?? 0}`,
    );
  }
  return lines.join("\n");
}

const useDbAuthentication = config.USE_DB_AUTHENTICATION;

const mainDb = useDbAuthentication
  ? makeDb(config.DATABASE_URL, "firecrawl-api", "main")
  : null;
// Without a distinct replica URL the "replica" pool points at the primary's
// pooler, so it must not hold a second warm set of connections there.
const replicaDb = useDbAuthentication
  ? makeDb(
      config.DATABASE_REPLICA_URL ?? config.DATABASE_URL,
      "firecrawl-api-rr",
      "replica",
      {
        keepWarm:
          config.DATABASE_REPLICA_URL !== undefined &&
          config.DATABASE_REPLICA_URL !== config.DATABASE_URL,
      },
    )
  : null;
// The index pool was the sole consumer behind the 2026-06-11 pgbouncer
// `08P01: no more connections allowed (max_client_conn)` incident. It runs
// against the transaction pooler, so every profile caps it well below the
// generic pools to keep the fleet-wide client-connection count under
// Supabase's 12000 ceiling.
const indexDb = makeDb(config.INDEX_DATABASE_URL, "firecrawl-index", "index");

if (useDbAuthentication && !mainDb) {
  logger.error(
    "DATABASE_URL is not configured. Drizzle client will not be initialized. Fix ENV configuration or disable DB authentication with USE_DB_AUTHENTICATION env variable",
  );
}

function proxyDb(get: () => DB | null, name: string): DB {
  return new Proxy(
    {},
    {
      get(_target, prop, receiver) {
        const client = get();
        if (client === null) {
          throw new Error(`${name} is not configured.`);
        }
        return Reflect.get(client, prop, receiver);
      },
    },
  ) as DB;
}

/** Main Postgres database (writes + reads). */
export const db: DB = proxyDb(() => mainDb, "Database client");

/** Read replica. Falls back to the main connection string when no replica URL is set. */
export const dbRr: DB = proxyDb(() => replicaDb, "Database replica client");

/** Separate index project database. */
export const dbIndex: DB = proxyDb(() => indexDb, "Index database client");
