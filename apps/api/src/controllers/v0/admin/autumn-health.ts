import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { logger } from "../../../lib/logger";
import { autumnClient } from "../../../services/autumn/client";
import {
  CREDITS_FEATURE_ID,
  TEAM_FEATURE_ID,
} from "../../../services/autumn/autumn.service";

type StepStatus = "healthy" | "unhealthy" | "skipped";

interface StepResult {
  status: StepStatus;
  data?: unknown;
  error?: string;
  durationMs?: number;
}

async function runStep(
  name: string,
  fn: () => Promise<unknown>,
): Promise<StepResult> {
  const start = Date.now();
  try {
    const data = await fn();
    return { status: "healthy", data, durationMs: Date.now() - start };
  } catch (error: any) {
    logger.error(`Autumn health check step "${name}" failed`, { error });
    return {
      status: "unhealthy",
      error: error.message ?? String(error),
      durationMs: Date.now() - start,
    };
  }
}

export async function autumnHealthController(req: Request, res: Response) {
  if (!autumnClient) {
    return res.status(503).json({
      status: "unhealthy",
      message: "Autumn client not configured (AUTUMN_SECRET_KEY missing)",
    });
  }

  const customerId = `fc-test-${randomUUID()}`;
  const entityId = `fc-test-ent-${randomUUID()}`;
  const details: Record<string, StepResult> = {};
  const totalStart = Date.now();

  try {
    // 1. Customer creation (mirrors ensureOrgProvisioned)
    details.customerCreate = await runStep("customerCreate", () =>
      autumnClient!.customers.getOrCreate({
        customerId,
        name: "Firecrawl Health Check",
      }),
    );
    if (details.customerCreate.status !== "healthy") {
      return respond(res, details, totalStart);
    }

    // 2. Entity creation (mirrors ensureTeamProvisioned — uses TEAM feature)
    details.entityCreate = await runStep("entityCreate", () =>
      autumnClient!.entities.create({
        customerId,
        entityId,
        featureId: TEAM_FEATURE_ID,
      }),
    );
    if (details.entityCreate.status !== "healthy") {
      await cleanup(customerId, entityId, details);
      return respond(res, details, totalStart);
    }

    // 3. Entity read — verify it was created
    details.entityGet = await runStep("entityGet", () =>
      autumnClient!.entities.get({ customerId, entityId }),
    );
    if (details.entityGet.status !== "healthy") {
      await cleanup(customerId, entityId, details);
      return respond(res, details, totalStart);
    }

    // 4. Baseline check — snapshot balance before tracking
    details.checkBaseline = await runStep("checkBaseline", () =>
      autumnClient!.check({
        customerId,
        entityId,
        featureId: CREDITS_FEATURE_ID,
        requiredBalance: 0,
      }),
    );
    if (details.checkBaseline.status !== "healthy") {
      await cleanup(customerId, entityId, details);
      return respond(res, details, totalStart);
    }

    // 5. Track +1 credit (mirrors trackCredits)
    details.trackCharge = await runStep("trackCharge", () =>
      autumnClient!.track({
        customerId,
        entityId,
        featureId: CREDITS_FEATURE_ID,
        value: 1,
      }),
    );
    if (details.trackCharge.status !== "healthy") {
      await cleanup(customerId, entityId, details);
      return respond(res, details, totalStart);
    }

    // 6. Check after charge — verify balance moved
    details.checkAfterCharge = await runStep("checkAfterCharge", () =>
      autumnClient!.check({
        customerId,
        entityId,
        featureId: CREDITS_FEATURE_ID,
        requiredBalance: 0,
      }),
    );

    // 7. Track -1 credit (mirrors refundCredits)
    details.trackRefund = await runStep("trackRefund", () =>
      autumnClient!.track({
        customerId,
        entityId,
        featureId: CREDITS_FEATURE_ID,
        value: -1,
      }),
    );

    // 8. Check after refund — verify balance restored
    details.checkAfterRefund = await runStep("checkAfterRefund", () =>
      autumnClient!.check({
        customerId,
        entityId,
        featureId: CREDITS_FEATURE_ID,
        requiredBalance: 0,
      }),
    );

    // 9. Lock credits (mirrors lockCredits — check with lock.enabled)
    const lockId = `fc-test-lock-${randomUUID()}`;
    details.lockCredits = await runStep("lockCredits", () =>
      autumnClient!.check({
        customerId,
        entityId,
        featureId: CREDITS_FEATURE_ID,
        requiredBalance: 1,
        lock: {
          enabled: true,
          lockId,
        },
      }),
    );

    // 10. Verify lock was allowed
    if (details.lockCredits.status === "healthy") {
      const lockData = details.lockCredits.data as any;
      if (lockData?.allowed !== true) {
        details.lockCredits = {
          ...details.lockCredits,
          status: "unhealthy",
          error: `Lock check returned allowed=${lockData?.allowed}, expected true`,
        };
      }
    }

    // 11. Finalize lock (mirrors finalizeCreditsLock)
    if (details.lockCredits.status === "healthy") {
      details.finalizeLock = await runStep("finalizeLock", () =>
        autumnClient!.balances.finalize({
          lockId,
          action: "release",
        }),
      );
    }

    // 12. Check after finalize — verify balance unchanged
    if (details.finalizeLock?.status === "healthy") {
      details.checkAfterFinalize = await runStep("checkAfterFinalize", () =>
        autumnClient!.check({
          customerId,
          entityId,
          featureId: CREDITS_FEATURE_ID,
          requiredBalance: 0,
        }),
      );
    }

    // 13–14. Cleanup
    await cleanup(customerId, entityId, details);

    // Validate all check calls returned allowed
    details.checkValidation = validateChecks(details);

    return respond(res, details, totalStart);
  } catch (error: any) {
    logger.error("Autumn health check unexpected error", { error });
    await cleanup(customerId, entityId, details).catch(() => {});
    return res.status(500).json({
      status: "unhealthy",
      message: error.message ?? String(error),
      details,
      durationMs: Date.now() - totalStart,
    });
  }
}

function extractRemaining(stepResult: StepResult): number | undefined {
  const data = stepResult.data as any;
  if (typeof data?.balance?.remaining === "number")
    return data.balance.remaining;
  return undefined;
}

function validateChecks(details: Record<string, StepResult>): StepResult {
  const baseline = extractRemaining(details.checkBaseline);
  const afterCharge = extractRemaining(details.checkAfterCharge);
  const afterRefund = extractRemaining(details.checkAfterRefund);
  const afterFinalize = details.checkAfterFinalize
    ? extractRemaining(details.checkAfterFinalize)
    : undefined;

  if (
    baseline === undefined ||
    afterCharge === undefined ||
    afterRefund === undefined
  ) {
    return {
      status: "unhealthy",
      error: "Could not extract balance.remaining from check responses",
      data: { baseline, afterCharge, afterRefund, afterFinalize },
    };
  }

  const errors: string[] = [];
  if (afterCharge !== baseline - 1) {
    errors.push(`Charge: expected ${baseline - 1}, got ${afterCharge}`);
  }
  if (afterRefund !== baseline) {
    errors.push(`Refund: expected ${baseline}, got ${afterRefund}`);
  }
  if (afterFinalize !== undefined && afterFinalize !== baseline) {
    errors.push(`Finalize: expected ${baseline}, got ${afterFinalize}`);
  }

  return {
    status: errors.length === 0 ? "healthy" : "unhealthy",
    data: { baseline, afterCharge, afterRefund, afterFinalize },
    ...(errors.length > 0 && { error: errors.join("; ") }),
  };
}

async function cleanup(
  customerId: string,
  entityId: string,
  details: Record<string, StepResult>,
): Promise<void> {
  details.entityDelete = await runStep("entityDelete", () =>
    autumnClient!.entities.delete({ customerId, entityId }),
  );
  details.customerDelete = await runStep("customerDelete", () =>
    autumnClient!.customers.delete({ customerId }),
  );
}

function respond(
  res: Response,
  details: Record<string, StepResult>,
  totalStart: number,
) {
  const allHealthy = Object.values(details).every(
    s => s.status === "healthy" || s.status === "skipped",
  );

  const status = allHealthy ? "healthy" : "unhealthy";
  const httpCode = allHealthy ? 200 : 500;

  if (allHealthy) {
    logger.info("Autumn health check passed");
  } else {
    logger.warn("Autumn health check failed", { details });
  }

  return res.status(httpCode).json({
    status,
    details,
    durationMs: Date.now() - totalStart,
  });
}
