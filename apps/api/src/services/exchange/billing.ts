import type { Logger } from "winston";
import { queueBillingOperation } from "../billing/batch_billing";
import { finalizeExchangeHold } from "./finalize";

type ExchangeCharge = {
  teamId: string;
  apiKeyId: number | null;
  chargeId: string;
  credits: number;
  maximumCredits: number;
  featureId: string;
  properties: Record<string, unknown>;
  lockId?: string;
  operationToken?: string;
  holdConfirmed?: boolean;
};

export async function settleExchangeBilling(
  charge: ExchangeCharge,
  checkpoint: (holdConfirmed: boolean) => Promise<void>,
  logger: Logger,
): Promise<boolean> {
  try {
    if (charge.lockId && !charge.holdConfirmed) {
      const confirmed = await finalizeExchangeHold({
        lockId: charge.lockId,
        teamId: charge.teamId,
        featureId: charge.featureId,
        heldValue: charge.maximumCredits,
        action: "confirm",
        overrideValue: charge.credits,
        externalRequestId: charge.operationToken,
        properties: charge.properties,
      });
      if (!confirmed) return false;
    }
    try {
      await checkpoint(Boolean(charge.lockId));
    } catch (error) {
      // The earlier confirm checkpoint can recover this idempotent handoff.
      logger.error("Exchange confirmed hold storage failed", {
        chargeId: charge.chargeId,
        error,
      });
    }
    const queued = await queueBillingOperation(
      charge.teamId,
      charge.credits,
      charge.apiKeyId,
      { endpoint: "scrape", chargeId: `exchange:${charge.chargeId}` },
      false,
      Boolean(charge.lockId),
      {
        usageRequestId: charge.chargeId,
        billingReference: `exchange:${charge.chargeId}`,
      },
    );
    return queued.success;
  } catch (error) {
    logger.error("Exchange settlement will retry", {
      chargeId: charge.chargeId,
      error,
    });
    return false;
  }
}
