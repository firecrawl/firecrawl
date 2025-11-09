import type { Logger } from "winston";

const DEFAULT_MAX_ATTEMPTS = 3;
const ALERT_THRESHOLD =
  Number(process.env.NUQ_FINALIZE_RETRY_ALERT_THRESHOLD) ||
  DEFAULT_MAX_ATTEMPTS;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function finalizeJobWithRetry(
  action: "finish" | "fail",
  finalize: () => Promise<boolean>,
  jobId: string,
  logger: Logger,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const success = await finalize();
      if (success) {
        logger.info("NuQ job finalized", {
          module: "nuq/finalize",
          jobId,
          action,
          attempt,
        });
        return;
      }
      lastError = new Error("NuQ job finalize update affected 0 rows");
    } catch (error) {
      lastError = error;
    }

    logger.warn("Failed to finalize job", {
      module: "nuq/finalize",
      jobId,
      action,
      attempt,
      maxAttempts,
      error:
        lastError instanceof Error
          ? lastError.message
          : ((lastError as any) ?? null),
    });

    if (attempt >= ALERT_THRESHOLD) {
      logger.error("NuQ finalize retry threshold reached", {
        module: "nuq/finalize",
        jobId,
        action,
        attempt,
        threshold: ALERT_THRESHOLD,
      });
    }

    if (attempt < maxAttempts) {
      await wait(50 * attempt);
    }
  }

  const errorToThrow =
    lastError instanceof Error
      ? lastError
      : new Error(`Failed to ${action} job ${jobId}`);
  logger.error("Failed to finalize job after retries", {
    module: "nuq/finalize",
    jobId,
    action,
    maxAttempts,
    error:
      lastError instanceof Error
        ? lastError.message
        : ((lastError as any) ?? null),
  });
  throw errorToThrow;
}
