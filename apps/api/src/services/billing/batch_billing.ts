import { logger } from "../../lib/logger";
import { getRedisConnection } from "../queue-service";
import { supabase_service } from "../supabase";
import * as Sentry from "@sentry/node";
import { withAuth } from "../../lib/withAuth";
import { setCachedACUC, setCachedACUCTeam } from "../../controllers/auth";

// Configuration constants
const BATCH_KEY = "billing_batch";
const BATCH_LOCK_KEY = "billing_batch_lock";
const BATCH_SIZE = 5000; // Batch size for processing
const BATCH_TIMEOUT = 15000; // 15 seconds processing interval
const LOCK_TIMEOUT = 30000; // 30 seconds lock timeout

// Define interfaces for billing operations
interface BillingOperation {
  team_id: string;
  subscription_id: string | null;
  credits: number;
  is_extract: boolean;
  timestamp: string;
  api_key_id: number | null;
}

// Grouped billing operations for batch processing
interface GroupedBillingOperation {
  team_id: string;
  subscription_id: string | null;
  total_credits: number;
  is_extract: boolean;
  api_key_id: number | null;
  operations: BillingOperation[];
}

// Function to acquire a lock for batch processing
async function acquireLock(): Promise<boolean> {
  const redis = getRedisConnection();
  // Set lock with NX (only if it doesn't exist) and PX (millisecond expiry)
  const result = await redis.set(BATCH_LOCK_KEY, "1", "PX", LOCK_TIMEOUT, "NX");
  const acquired = result === "OK";
  if (acquired) {
    logger.info("🔒 Acquired billing batch processing lock");
  }
  return acquired;
}

// Function to release the lock
async function releaseLock() {
  const redis = getRedisConnection();
  await redis.del(BATCH_LOCK_KEY);
  logger.info("🔓 Released billing batch processing lock");
}

// Main function to process the billing batch
export async function processBillingBatch() {
  const redis = getRedisConnection();

  // Try to acquire lock
  if (!(await acquireLock())) {
    return;
  }

  try {
    // Get all operations from Redis list
    const operations: BillingOperation[] = [];
    while (operations.length < BATCH_SIZE) {
      const op = await redis.lpop(BATCH_KEY);
      if (!op) break;
      operations.push(JSON.parse(op));
    }

    if (operations.length === 0) {
      logger.info("No billing operations to process in batch");
      return;
    }

    logger.info(
      `📦 Processing batch of ${operations.length} billing operations`,
    );

    // Group operations by team_id and subscription_id
    const groupedOperations = new Map<string, GroupedBillingOperation>();

    for (const op of operations) {
      const key = `${op.team_id}:${op.subscription_id ?? "null"}:${op.is_extract}:${op.api_key_id}`;

      if (!groupedOperations.has(key)) {
        groupedOperations.set(key, {
          team_id: op.team_id,
          subscription_id: op.subscription_id,
          total_credits: 0,
          is_extract: op.is_extract,
          api_key_id: op.api_key_id,
          operations: [],
        });
      }

      const group = groupedOperations.get(key)!;
      group.total_credits += op.credits;
      group.operations.push(op);
    }

    // Process each group of operations
    for (const [key, group] of groupedOperations.entries()) {
      logger.info(
        `🔄 Billing team ${group.team_id} for ${group.total_credits} credits`,
        {
          team_id: group.team_id,
          subscription_id: group.subscription_id,
          total_credits: group.total_credits,
          operation_count: group.operations.length,
          is_extract: group.is_extract,
        },
      );

      // Skip billing for preview teams
      if (group.team_id === "preview" || group.team_id.startsWith("preview_")) {
        logger.info(`Skipping billing for preview team ${group.team_id}`);
        continue;
      }

      try {
        // Execute the actual billing
        await withAuth(supaBillTeam, {
          success: true,
          message: "No DB, bypassed.",
        })(
          group.team_id,
          group.subscription_id,
          group.total_credits,
          group.api_key_id,
          logger,
          group.is_extract,
        );

        logger.info(
          `✅ Successfully billed team ${group.team_id} for ${group.total_credits} ${group.is_extract ? "tokens" : "credits"}`,
        );
      } catch (error) {
        logger.error(`❌ Failed to bill team ${group.team_id}`, {
          error,
          group,
        });
        Sentry.captureException(error, {
          data: {
            operation: "batch_billing",
            team_id: group.team_id,
            credits: group.total_credits,
          },
        });
      }
    }

    logger.info("✅ Billing batch processing completed successfully");
  } catch (error) {
    logger.error("Error processing billing batch", { error });
    Sentry.captureException(error, {
      data: {
        operation: "batch_billing_process",
      },
    });
  } finally {
    await releaseLock();
  }
}

// Start periodic batch processing
let batchInterval: NodeJS.Timeout | null = null;

export function startBillingBatchProcessing() {
  if (batchInterval) return;

  logger.info("🔄 Starting periodic billing batch processing");
  batchInterval = setInterval(async () => {
    const queueLength = await getRedisConnection().llen(BATCH_KEY);
    logger.info(`Checking billing batch queue (${queueLength} items pending)`);
    await processBillingBatch();
  }, BATCH_TIMEOUT);

  // Unref to not keep process alive
  batchInterval.unref();
}

// Add a billing operation to the queue
export async function queueBillingOperation(
  team_id: string,
  subscription_id: string | null | undefined,
  credits: number,
  api_key_id: number | null,
  is_extract: boolean = false,
) {
  // Skip queuing for preview teams
  if (team_id === "preview" || team_id.startsWith("preview_")) {
    logger.info(`Skipping billing queue for preview team ${team_id}`);
    return { success: true, message: "Preview team, no credits used" };
  }

  logger.info(`Queueing billing operation for team ${team_id}`, {
    team_id,
    subscription_id,
    credits,
    is_extract,
  });

  try {
    const operation: BillingOperation = {
      team_id,
      subscription_id: subscription_id ?? null,
      credits,
      is_extract,
      timestamp: new Date().toISOString(),
      api_key_id,
    };

    // Add operation to Redis list
    const redis = getRedisConnection();
    await redis.rpush(BATCH_KEY, JSON.stringify(operation));
    const queueLength = await getRedisConnection().llen(BATCH_KEY);
    logger.info(
      `📥 Added billing operation to queue (${queueLength} total pending)`,
      {
        team_id,
        credits,
      },
    );

    // Start batch processing if not already started
    startBillingBatchProcessing();

    // If we have enough items, trigger immediate processing
    if (queueLength >= BATCH_SIZE) {
      logger.info(
        "🔄 Billing queue reached batch size, triggering immediate processing",
      );
      await processBillingBatch();
    }
    // TODO is there a better way to do this?

    // Update cached credits used immediately to provide accurate feedback to users
    // This is optimistic - actual billing happens in batch
    // Should we add this?
    // I guess batch is fast enough that it's fine

    // if (process.env.USE_DB_AUTHENTICATION === "true") {
    //   (async () => {
    //     // Get API keys for this team to update in cache
    //     const { data } = await supabase_service
    //       .from("api_keys")
    //       .select("key")
    //       .eq("team_id", team_id);

    //     for (const apiKey of (data ?? []).map(x => x.key)) {
    //       await setCachedACUC(apiKey, (acuc) =>
    //         acuc
    //           ? {
    //               ...acuc,
    //               credits_used: acuc.credits_used + credits,
    //               adjusted_credits_used: acuc.adjusted_credits_used + credits,
    //               remaining_credits: acuc.remaining_credits - credits,
    //             }
    //           : null,
    //       );
    //     }
    //   })().catch(error => {
    //     logger.error("Failed to update cached credits", { error, team_id });
    //   });
    // }

    return { success: true };
  } catch (error) {
    logger.error("Error queueing billing operation", { error, team_id });
    Sentry.captureException(error, {
      data: {
        operation: "queue_billing",
        team_id,
        credits,
      },
    });
    return { success: false, error };
  }
}

// Modified version of the billing function for batch operations
async function supaBillTeam(
  team_id: string,
  subscription_id: string | null | undefined,
  credits: number,
  api_key_id: number | null,
  __logger?: any,
  is_extract: boolean = false,
) {
  const _logger = (__logger ?? logger).child({
    module: "credit_billing",
    method: "supaBillTeam",
    teamId: team_id,
    subscriptionId: subscription_id,
    credits,
  });

  if (team_id === "preview" || team_id.startsWith("preview_")) {
    return { success: true, message: "Preview team, no credits used" };
  }

  _logger.info(`Batch billing team ${team_id} for ${credits} credits`);

  // Perform the actual database operation
  const { data, error } = await supabase_service.rpc("bill_team_6", {
    _team_id: team_id,
    sub_id: subscription_id ?? null,
    fetch_subscription: subscription_id === undefined,
    credits,
    i_api_key_id: api_key_id ?? null,
    is_extract_param: is_extract,
  });

  if (error) {
    Sentry.captureException(error);
    _logger.error("Failed to bill team.", { error });
    return { success: false, error };
  }

  await getRedisConnection().sadd("billed_teams", team_id);

  // Update cached ACUC to reflect the new credit usage
  (async () => {
    for (const apiKey of (data ?? []).map(x => x.api_key)) {
      await setCachedACUC(apiKey, is_extract, acuc =>
        acuc
          ? {
              ...acuc,
              credits_used: acuc.credits_used + credits,
              adjusted_credits_used: acuc.adjusted_credits_used + credits,
              remaining_credits: acuc.remaining_credits - credits,
            }
          : null,
      );
      await setCachedACUCTeam(team_id, is_extract, acuc =>
        acuc
          ? {
              ...acuc,
              credits_used: acuc.credits_used + credits,
              adjusted_credits_used: acuc.adjusted_credits_used + credits,
              remaining_credits: acuc.remaining_credits - credits,
            }
          : null,
      );
    }
  })().catch(error => {
    _logger.error("Failed to update cached credits", { error, team_id });
  });

  return { success: true, data };
}

// Cleanup on exit
process.on("beforeExit", async () => {
  if (batchInterval) {
    clearInterval(batchInterval);
    batchInterval = null;
    logger.info("Stopped periodic billing batch processing");
  }
  await processBillingBatch();
});
