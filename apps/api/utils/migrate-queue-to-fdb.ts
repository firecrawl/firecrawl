/**
 * Migration Script: Redis + PostgreSQL Backlog -> FoundationDB
 *
 * This script migrates jobs from:
 * 1. Redis concurrency queues (concurrency-limit-queue:*)
 * 2. PostgreSQL backlog table (nuq.queue_scrape_backlog)
 *
 * To FoundationDB with the new key structure.
 *
 * Usage:
 *   npx tsx utils/migrate-queue-to-fdb.ts [--dry-run] [--team-id=<id>]
 *
 * Options:
 *   --dry-run    Preview what would be migrated without making changes
 *   --team-id    Only migrate jobs for a specific team
 */

import "dotenv/config";
import { Pool } from "pg";
import Redis from "ioredis";
import { config } from "../src/config";
import * as fdbQueue from "../src/services/fdb-queue-client";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const teamIdArg = args.find(a => a.startsWith("--team-id="));
const specificTeamId = teamIdArg ? teamIdArg.split("=")[1] : null;

console.log("=== FDB Queue Migration Script ===");
console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
if (specificTeamId) {
  console.log(`Team filter: ${specificTeamId}`);
}
console.log("");

async function main() {
  // Initialize connections
  if (!config.FDB_QUEUE_SERVICE_URL) {
    console.error("ERROR: FDB_QUEUE_SERVICE_URL is not configured");
    process.exit(1);
  }

  if (!fdbQueue.initFDB()) {
    console.error("ERROR: Failed to initialize FDB Queue Service client");
    process.exit(1);
  }

  const redis = new Redis(config.REDIS_URL || "redis://localhost:6379");
  const pgPool = new Pool({
    connectionString: config.NUQ_DATABASE_URL,
    application_name: "fdb-migration",
  });

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  try {
    // === Phase 1: Migrate from Redis ===
    console.log("=== Phase 1: Migrating from Redis ===");

    // Get all team queue keys
    const queueKeys = await redis.smembers("concurrency-limit-queues");
    console.log(`Found ${queueKeys.length} team queues in Redis`);

    for (const queueKey of queueKeys) {
      const teamId = queueKey.replace("concurrency-limit-queue:", "");

      if (specificTeamId && teamId !== specificTeamId) {
        continue;
      }

      // Get all jobs from the Redis sorted set
      const members = await redis.zrange(queueKey, 0, -1, "WITHSCORES");

      if (members.length === 0) {
        continue;
      }

      console.log(
        `\nTeam ${teamId}: ${members.length / 2} jobs in Redis queue`,
      );

      for (let i = 0; i < members.length; i += 2) {
        const jobJson = members[i];
        const score = parseFloat(members[i + 1]);

        try {
          const job = JSON.parse(jobJson);
          const timeout = score === Infinity ? Infinity : score - Date.now();

          // Skip expired jobs
          if (timeout !== Infinity && timeout <= 0) {
            console.log(`  Skipping expired job: ${job.id}`);
            totalSkipped++;
            continue;
          }

          if (!dryRun) {
            await fdbQueue.pushJob(
              teamId,
              {
                id: job.id,
                data: job.data,
                priority: job.priority ?? 0,
                listenable: job.listenable ?? false,
                listenChannelId: job.listenChannelId,
              },
              timeout === Infinity ? 0 : timeout,
              job.data?.crawl_id,
            );
          }

          console.log(
            `  Migrated job: ${job.id} (priority: ${job.priority}, crawl: ${job.data?.crawl_id ?? "none"})`,
          );
          totalMigrated++;
        } catch (error) {
          console.error(`  Error migrating job: ${error}`);
          totalErrors++;
        }
      }
    }

    // === Phase 2: Migrate from PostgreSQL Backlog ===
    console.log("\n=== Phase 2: Migrating from PostgreSQL Backlog ===");

    let pgQuery = `
      SELECT id, data, priority, listen_channel_id, owner_id, group_id, times_out_at, created_at
      FROM nuq.queue_scrape_backlog
    `;
    const pgParams: string[] = [];

    if (specificTeamId) {
      pgQuery += " WHERE owner_id = $1";
      pgParams.push(specificTeamId);
    }

    pgQuery += " ORDER BY created_at ASC";

    const result = await pgPool.query(pgQuery, pgParams);
    console.log(`Found ${result.rows.length} jobs in PostgreSQL backlog`);

    for (const row of result.rows) {
      try {
        const teamId = row.owner_id;
        const crawlId = row.group_id;
        const timeout = row.times_out_at
          ? new Date(row.times_out_at).getTime() - Date.now()
          : Infinity;

        // Skip expired jobs
        if (timeout !== Infinity && timeout <= 0) {
          console.log(`  Skipping expired job: ${row.id}`);
          totalSkipped++;
          continue;
        }

        if (!dryRun) {
          await fdbQueue.pushJob(
            teamId,
            {
              id: row.id,
              data: row.data,
              priority: row.priority ?? 0,
              listenable: !!row.listen_channel_id,
              listenChannelId: row.listen_channel_id,
            },
            timeout === Infinity ? 0 : timeout,
            crawlId,
          );
        }

        console.log(
          `  Migrated job: ${row.id} (priority: ${row.priority}, crawl: ${crawlId ?? "none"})`,
        );
        totalMigrated++;
      } catch (error) {
        console.error(`  Error migrating job ${row.id}: ${error}`);
        totalErrors++;
      }
    }

    // === Summary ===
    console.log("\n=== Migration Summary ===");
    console.log(`Total migrated: ${totalMigrated}`);
    console.log(`Total skipped (expired): ${totalSkipped}`);
    console.log(`Total errors: ${totalErrors}`);

    if (dryRun) {
      console.log(
        "\nThis was a DRY RUN. No changes were made. Run without --dry-run to perform the migration.",
      );
    } else {
      console.log("\nMigration complete!");
      console.log("\nNext steps:");
      console.log("1. Verify counts match between old and new systems");
      console.log("2. Run the PostgreSQL migration to remove backlog table");
      console.log(
        "3. Clear Redis keys (optional): redis-cli KEYS 'concurrency-limit-queue:*' | xargs redis-cli DEL",
      );
    }
  } finally {
    await redis.quit();
    await pgPool.end();
  }
}

main().catch(error => {
  console.error("Migration failed:", error);
  process.exit(1);
});
