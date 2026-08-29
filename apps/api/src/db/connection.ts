import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "../config";
import { logger } from "../lib/logger";

type DB = NodePgDatabase;

interface PoolSizing {
  /** Max client connections this pool opens to the pooler. Default 20. */
  max?: number;
  /** Idle connections held open permanently. Default 0. */
  min?: number;
}

// Registry of every pool we create, for /metrics exposure.
const dbPools: { name: string; pool: Pool }[] = [];

function makeDb(
  connectionString: string | undefined,
  applicationName: string,
  sizing: PoolSizing = {},
): DB | null {
  if (!connectionString) {
    return null;
  }

  const pool = new Pool({
    connectionString,
    application_name: applicationName,
    // Each process opens up to `max` client connections per pool against the
    // (transaction) pooler. Supabase pins pgbouncer's max_client_conn at 12000,
    // so the fleet-wide budget is `pods * sum(max across pools)`. Keep these
    // small — the transaction pooler multiplexes server connections, so a large
    // per-process client pool buys little throughput but eats the global cap.
    // `min: 0` lets idle pods release connections instead of holding them.
    max: sizing.max ?? 20,
    min: sizing.min ?? 0,
    keepAlive: true,
  });
  dbPools.push({ name: applicationName, pool });
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
  return lines.join("\n");
}

const useDbAuthentication = config.USE_DB_AUTHENTICATION;

const mainDb = useDbAuthentication
  ? makeDb(config.DATABASE_URL, "firecrawl-api")
  : null;
const replicaDb = useDbAuthentication
  ? makeDb(
      config.DATABASE_REPLICA_URL ?? config.DATABASE_URL,
      "firecrawl-api-rr",
    )
  : null;
// The index pool was the sole consumer behind the 2026-06-11 pgbouncer
// `08P01: no more connections allowed (max_client_conn)` incident. It runs
// against the transaction pooler, so cap it well below the generic 20 to keep
// the fleet-wide client-connection count under Supabase's 12000 ceiling.
const indexDb = makeDb(config.INDEX_DATABASE_URL, "firecrawl-index", {
  max: 6,
  min: 0,
});

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
