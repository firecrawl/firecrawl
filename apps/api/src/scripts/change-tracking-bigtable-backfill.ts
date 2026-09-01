import "dotenv/config";
import { Pool } from "pg";
import { config } from "../config";
import { logger } from "../lib/logger";
import {
  changeTrackingBigtableConfigured,
  changeTrackingInsertScrapesBigtable,
  ensureChangeTrackingTable,
} from "../lib/change-tracking-store";

// One-shot migration: backfills the Bigtable change tracking store with the
// latest scrape per (team, url, tag) from the Postgres change_tracking_scrapes
// table. Idempotent -- re-running is safe because cell timestamps (date_added)
// make latest-wins upserts.
//
// Usage:
//   Requires DATABASE_URL + the BIGTABLE_* vars (reads Postgres directly,
//   writes Bigtable directly).
// Env knobs:
//   BACKFILL_TEAM_CURSOR  resume strictly after this team_id
//   BACKFILL_DRY_RUN      "1" to read + count without writing
//   BACKFILL_BATCH        rows per Bigtable mutate call (default 500)

// The table/column names below are inferred from the change_tracking_insert_scrape
// RPC signature; they are verified against information_schema at startup so a
// schema mismatch fails loudly instead of writing garbage.
const PG_TABLE = "change_tracking_scrapes";
const PG_COLUMNS = [
  "team_id",
  "url",
  "job_id",
  "change_tracking_tag",
  "date_added",
] as const;

const BATCH = parseInt(process.env.BACKFILL_BATCH || "500", 10);

async function verifySchema(pool: Pool) {
  const res = await pool.query(
    `select column_name from information_schema.columns
     where table_name = $1 and table_schema not in ('pg_catalog', 'information_schema')`,
    [PG_TABLE],
  );
  const present = new Set(res.rows.map(r => r.column_name));
  if (present.size === 0) {
    throw new Error(
      `Table ${PG_TABLE} not found on this database -- set DATABASE_URL to the database holding the change tracking data`,
    );
  }
  const missing = PG_COLUMNS.filter(c => !present.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Table ${PG_TABLE} is missing expected columns: ${missing.join(", ")} -- update the script`,
    );
  }
}

async function teamIds(
  pool: Pool,
  afterTeamId: string | null,
): Promise<string[]> {
  const res = await pool.query(
    `select distinct team_id from ${PG_TABLE}
     where team_id > $1
     order by team_id
     limit 1000`,
    [afterTeamId ?? ""],
  );
  return res.rows.map(r => r.team_id as string);
}

type ScrapeRow = {
  url: string;
  change_tracking_tag: string | null;
  job_id: string;
  date_added: Date;
};

async function latestRowsForTeam(
  pool: Pool,
  teamId: string,
): Promise<ScrapeRow[]> {
  const res = await pool.query(
    `select distinct on (url, change_tracking_tag)
       url, change_tracking_tag, job_id, date_added
     from ${PG_TABLE}
     where team_id = $1
       and job_id is not null
       and date_added is not null
     order by url, change_tracking_tag, date_added desc`,
    [teamId],
  );
  return res.rows;
}

async function main() {
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  if (!changeTrackingBigtableConfigured()) {
    throw new Error("BIGTABLE_INSTANCE_ID must be set");
  }

  const dryRun = process.env.BACKFILL_DRY_RUN === "1";
  const cursor = process.env.BACKFILL_TEAM_CURSOR || null;

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    application_name: "change-tracking-bigtable-backfill",
    max: 4,
  });
  try {
    await verifySchema(pool);
    logger.info("Schema verified, provisioning Bigtable table", {
      table: config.BIGTABLE_CHANGE_TRACKING_TABLE || "change_tracking",
    });
    if (!dryRun) {
      await ensureChangeTrackingTable();
    }

    let teams = 0;
    let rows = 0;
    let after = cursor;
    for (;;) {
      const ids = await teamIds(pool, after);
      if (ids.length === 0) break;
      for (const teamId of ids) {
        const scrapes = await latestRowsForTeam(pool, teamId);
        if (scrapes.length > 0 && !dryRun) {
          for (let i = 0; i < scrapes.length; i += BATCH) {
            await changeTrackingInsertScrapesBigtable(
              scrapes.slice(i, i + BATCH).map(s => ({
                team_id: teamId,
                url: s.url,
                job_id: s.job_id,
                tag: s.change_tracking_tag,
                date_added: new Date(s.date_added),
              })),
            );
          }
        }
        teams++;
        rows += scrapes.length;
        if (teams % 50 === 0) {
          logger.info("Backfill progress", {
            teams,
            rows,
            lastTeamId: teamId,
          });
        }
      }
      after = ids[ids.length - 1];
      if (ids.length < 1000) break;
    }

    logger.info("Backfill complete", {
      teams,
      rows,
      dryRun,
      lastTeamId: after,
      note: dryRun
        ? "dry run -- nothing was written"
        : "to resume after a crash, set BACKFILL_TEAM_CURSOR to lastTeamId",
    });
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  logger.error("Backfill failed", { error });
  process.exitCode = 1;
});
