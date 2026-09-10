import { withAuth } from "../../lib/withAuth";
import { queueBillingOperation } from "./batch_billing";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import { toAutumnBillingProperties, type BillingMetadata } from "./types";
import type { Logger } from "winston";

export async function billTeam(
  team_id: string,
  credits: number,
  api_key_id: number | null,
  billing: BillingMetadata,
  logger?: Logger,
) {
  return withAuth(
    async (
      team_id: string,
      credits: number,
      api_key_id: number | null,
      billing: BillingMetadata,
      logger: Logger | undefined,
    ) => {
      const autumnProperties = {
        source: "billTeam",
        ...toAutumnBillingProperties(billing),
        apiKeyId: api_key_id,
      };
      const featureId = featureIdForBillingEndpoint(billing.endpoint);
      // Stable per-charge key (firebill route only): a caller retry or re-run
      // job with the same chargeId dedupes instead of double-billing.
      const trackedInRequest = await autumnService.trackCredits({
        teamId: team_id,
        value: credits,
        properties: autumnProperties,
        featureId,
        idempotencyKey: billing.chargeId
          ? `fc:track:${billing.endpoint}:${billing.chargeId}`
          : undefined,
      });

      const result = await queueBillingOperation(
        team_id,
        credits,
        api_key_id,
        billing,
        false,
        trackedInRequest,
      );

      if (!result.success && trackedInRequest) {
        if (await autumnService.isRoutedThroughFirebill(team_id)) {
          // No compensating refund on the firebill route: the tracked charge
          // is durable and correct, and a refund here poisons a retried
          // request — its track would be deduped by Autumn against the same
          // idempotency key (no new charge) while the ledger enqueue succeeds,
          // leaving Autumn net-zero for billed work.
          logger?.warn(
            "billing enqueue failed on the firebill route; charge stands",
            { team_id, credits, billing },
          );
        } else {
          await autumnService.refundCredits({
            teamId: team_id,
            value: credits,
            properties: autumnProperties,
            featureId,
            // Distinct from the track key: the refund is its own charge event.
            idempotencyKey: billing.chargeId
              ? `fc:refund:${billing.endpoint}:${billing.chargeId}`
              : undefined,
          });
        }
      }

      return result;
    },
    { success: true, message: "No DB, bypassed." },
  )(team_id, credits, api_key_id, billing, logger);
}
