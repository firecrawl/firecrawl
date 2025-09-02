import { logger } from "../../lib/logger";
import { getBillingQueue } from "../queue-service";
import { v4 as uuidv4 } from "uuid";
import * as Sentry from "@sentry/node";

/**
 * Adds a job to the billing queue to trigger batch processing
 * This can be used when we want to ensure billing is processed without waiting for the next interval
 */
export async function addBillingBatchJob() {
  try {
    const jobId = uuidv4();
    logger.info("Adding billing batch job to queue", { jobId });

    await getBillingQueue().add(
      "process-batch",
      {
        timestamp: new Date().toISOString(),
      },
      {
        jobId,
        priority: 10,
      },
    );

    return { success: true, jobId };
  } catch (error) {
    logger.error("Error adding billing batch job", { error });
    Sentry.captureException(error, {
      data: {
        operation: "add_billing_batch_job",
      },
    });
    return { success: false, error };
  }
}

/**
 * Trigger immediate processing of any pending billing operations
 * This is useful for ensuring billing operations are processed without delay
 */
export async function triggerImmediateBillingProcess() {
  try {
    return await addBillingBatchJob();
  } catch (error) {
    logger.error("Error triggering immediate billing process", { error });
    return { success: false, error };
  }
}
