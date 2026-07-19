import { logger } from "../../lib/logger";
import { getRedisConnection } from "../queue-service";
import { billTeam7 } from "../../db/rpc";
import * as Sentry from "@sentry/node";
import { withAuth } from "../../lib/withAuth";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import {
  resolveBillingMetadata,
  toAutumnBillingProperties,
  type BillingEndpoint,
  type BillingMetadata,
} from "./types";
import { reportExchangeBilling } from "../../lib/exchange";

// Upper bound on concurrent Exchange confirmation requests across the
// whole worker, so slow or retrying deliveries from overlapping batch
// runs never stack into a burst against the Exchange.
const EXCHANGE_CONFIRM_CONCURRENCY = 16;
let exchangeConfirmSlots = EXCHANGE_CONFIRM_CONCURRENCY;
const exchangeConfirmWaiters: Array<() => void> = [];

async function withExchangeConfirmSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (exchangeConfirmSlots > 0) {
    exchangeConfirmSlots--;
  } else {
    await new Promise<void>(resolve => exchangeConfirmWaiters.push(resolve));
  }
  try {
    return await fn();
  } finally {
    const next = exchangeConfirmWaiters.shift();
    if (next !== undefined) {
      next();
    } else {
      exchangeConfirmSlots++;
    }
  }
}

// Confirm the Exchange accesses behind a set of committed billing
// operations. Runs after the batch lock is released so an Exchange outage
// can never stall the billing loop past its lease. reportExchangeBilling
// retries internally and never throws; a sustained failure leaves the
// event pending on the Exchange, which flags unresolved events for
// reconciliation.
async function confirmExchangeOutcomes(
  operations: BillingOperation[],
): Promise<void> {
  // A small worker pool pulls operations one at a time, so a slow
  // Exchange queues at most EXCHANGE_CONFIRM_CONCURRENCY waiters per
  // invocation on the shared budget instead of one per operation.
  let nextIndex = 0;
  const workerCount = Math.min(
    EXCHANGE_CONFIRM_CONCURRENCY,
    operations.length,
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= operations.length) {
          return;
        }
        const op = operations[index];
        await withExchangeConfirmSlot(() =>
          reportExchangeBilling({
            accessEventId: op.exchange_access_event_id!,
            status: "confirmed",
            ...(op.billing_reference === undefined
              ? {}
              : { billingReference: op.billing_reference }),
          }),
        );
      }
    }),
  );
}

// Configuration constants
const BATCH_KEY = "billing_batch";
const BATCH_LOCK_KEY = "billing_batch_lock";
const BATCH_SIZE = 5000; // Batch size for processing
const BATCH_TIMEOUT = 15000; // 15 seconds processing interval
const LOCK_TIMEOUT = 30000; // 30 seconds lock timeout

// Define interfaces for billing operations
interface BillingOperation {
  team_id: string;
  credits: number;
  billing?: BillingMetadata;
  endpoint?: BillingEndpoint;
  is_extract: boolean;
  timestamp: string;
  api_key_id: number | null;
  autumnTrackInRequest: boolean;
  // Exchange access backing this operation, if any: its ledger event is
  // confirmed once the debit commits. Failed or ambiguous commits leave
  // the event pending for reconciliation rather than voiding it.
  exchange_access_event_id?: string;
  billing_reference?: string;
}

// Grouped billing operations for batch processing
interface GroupedBillingOperation {
  team_id: string;
  total_credits: number;
  billing: BillingMetadata;
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

async function refundRequestTrackedCredits(group: GroupedBillingOperation) {
  const requestTrackedCredits = group.operations
    .filter(op => op.autumnTrackInRequest)
    .reduce((sum, op) => sum + op.credits, 0);

  if (requestTrackedCredits <= 0) return;

  try {
    await autumnService.refundCredits({
      teamId: group.team_id,
      value: requestTrackedCredits,
      properties: {
        source: "processBillingBatch",
        ...toAutumnBillingProperties(group.billing),
        apiKeyId: group.api_key_id,
      },
      featureId: featureIdForBillingEndpoint(group.billing.endpoint),
    });
  } catch (error) {
    logger.warn("Failed to refund Autumn request-tracked credits", {
      error,
      team_id: group.team_id,
      credits: requestTrackedCredits,
      billing: group.billing,
    });
    Sentry.captureException(error, {
      data: {
        operation: "batch_billing_refund",
        team_id: group.team_id,
        credits: requestTrackedCredits,
      },
    });
  }
}

/**
 * Dequeues pending billing operations from Redis, groups them by team, and
 * commits each group to Supabase via the `bill_team_7` RPC.
 */
export async function processBillingBatch() {
  const redis = getRedisConnection();

  // Try to acquire lock
  if (!(await acquireLock())) {
    return;
  }

  // Exchange operations whose debit committed this run; their ledger
  // confirmations are delivered after the lock is released.
  const committedExchangeOps: BillingOperation[] = [];

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

    // Group operations by team_id, endpoint, is_extract, and api_key_id
    const groupedOperations = new Map<string, GroupedBillingOperation>();

    for (const op of operations) {
      const billing = resolveBillingMetadata({
        billing:
          op.billing ?? (op.endpoint ? { endpoint: op.endpoint } : undefined),
        isExtract: op.is_extract,
      });
      const key = `${op.team_id}:${billing.endpoint}:${op.is_extract}:${op.api_key_id}`;

      if (!groupedOperations.has(key)) {
        groupedOperations.set(key, {
          team_id: op.team_id,
          total_credits: 0,
          billing,
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
    for (const [, group] of groupedOperations.entries()) {
      logger.info(
        `🔄 Billing team ${group.team_id} for ${group.total_credits} credits`,
        {
          team_id: group.team_id,
          total_credits: group.total_credits,
          billing: group.billing,
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
        const billingResult = await withAuth(supaBillTeam, {
          success: true,
          message: "No DB, bypassed.",
        })(
          group.team_id,
          group.total_credits,
          group.api_key_id,
          logger,
          group.is_extract,
        );

        if (!billingResult.success) {
          await refundRequestTrackedCredits(group);
          // Deliberately no Exchange outcome here: supaBillTeam maps thrown
          // errors to success: false, and a transport error can occur after
          // the debit committed, so voiding could erase a real debit. The
          // events stay pending on the Exchange, which flags unresolved
          // events for reconciliation.
          logger.warn(
            `⚠️ Billing returned success: false for team ${group.team_id}`,
            {
              billingResult,
              team_id: group.team_id,
              credits: group.total_credits,
            },
          );
          continue;
        }

        logger.info(
          `✅ Successfully billed team ${group.team_id} for ${group.total_credits} credits`,
        );

        // Ledger commit only — usage is tracked to Autumn at request time, not here.

        // The debit is committed: confirm the Exchange accesses it covered
        // once the batch lock is released.
        committedExchangeOps.push(
          ...group.operations.filter(
            op => op.exchange_access_event_id !== undefined,
          ),
        );
      } catch (error) {
        await refundRequestTrackedCredits(group);
        // No Exchange outcome here either — same ambiguity as the
        // success: false branch above; the events stay pending.
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

  await confirmExchangeOutcomes(committedExchangeOps);
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

/**
 * Enqueues a billing operation for async batch processing.
 *
 * Internal billing operations are batched and committed to Supabase.
 */
export async function queueBillingOperation(
  team_id: string,
  credits: number,
  api_key_id: number | null,
  billing: BillingMetadata,
  is_extract: boolean = false,
  autumnTrackInRequest: boolean = false,
  exchange?: { accessEventId: string; billingReference?: string },
) {
  // Skip queuing for preview teams
  if (team_id === "preview" || team_id.startsWith("preview_")) {
    logger.info(`Skipping billing queue for preview team ${team_id}`);
    return { success: true, message: "Preview team, no credits used" };
  }

  logger.info(`Queueing billing operation for team ${team_id}`, {
    team_id,
    credits,
    billing,
    is_extract,
  });

  try {
    const operation: BillingOperation = {
      team_id,
      credits,
      billing,
      is_extract,
      timestamp: new Date().toISOString(),
      api_key_id,
      autumnTrackInRequest,
      ...(exchange === undefined
        ? {}
        : {
            exchange_access_event_id: exchange.accessEventId,
            ...(exchange.billingReference === undefined
              ? {}
              : { billing_reference: exchange.billingReference }),
          }),
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
  credits: number,
  api_key_id: number | null,
  __logger?: any,
  is_extract: boolean = false,
) {
  const _logger = (__logger ?? logger).child({
    module: "credit_billing",
    method: "supaBillTeam",
    teamId: team_id,
    credits,
  });

  if (team_id === "preview" || team_id.startsWith("preview_")) {
    return { success: true, message: "Preview team, no credits used" };
  }

  _logger.info(`Batch billing team ${team_id} for ${credits} credits`);

  // Perform the actual database operation
  let data: { api_key: string }[];
  try {
    data = await billTeam7({
      team_id,
      subscription_id: null,
      credits,
      api_key_id: api_key_id ?? null,
      is_extract,
    });
  } catch (error) {
    Sentry.captureException(error);
    _logger.error("Failed to bill team.", { error });
    return { success: false, error };
  }

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
