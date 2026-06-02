import { Pool } from "pg";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { config } from "../config";
import { logger } from "../lib/logger";

type DB = NodePgDatabase;

function makeDb(
  connectionString: string | undefined,
  applicationName: string,
): DB | null {
  if (!connectionString) {
    return null;
  }

  const pool = new Pool({
    connectionString,
    application_name: applicationName,
  });
  pool.on("error", err =>
    logger.error("Error in idle Postgres client", {
      err,
      module: "db",
      applicationName,
    }),
  );

  return drizzle({ client: pool });
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
const indexDb = makeDb(config.INDEX_DATABASE_URL, "firecrawl-index");

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
