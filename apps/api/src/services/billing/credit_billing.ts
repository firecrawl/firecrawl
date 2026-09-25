import { withAuth } from "../../lib/withAuth";
import { queueBillingOperation } from "./batch_billing";
import {
  autumnService,
  featureIdForBillingEndpoint,
} from "../autumn/autumn.service";
import { toAutumnBillingProperties, type BillingMetadata } from "./types";
import type { Logger } from "winston";

/**
 * `org_id` is the team's Autumn customer. It is nullable here and nowhere
 * below: this is the facade every controller and worker bills through, and
 * preview/keyless teams legitimately have no org. Without one there is no
 * customer to charge, so the Autumn track is skipped — the same `false` it
 * already answers for those teams — while the billing enqueue, which needs no
 * org, still runs. The request-time track is the charge.
 */
export async function billTeam(
  team_id: string,
  org_id: string | null,
  credits: number,
  api_key_id: number | null,
  billing: BillingMetadata,
  logger?: Logger,
) {
  return withAuth(
    async (
      team_id: string,
      org_id: string | null,
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

      let trackedInRequest = false;
      if (org_id !== null) {
        // Stable per-charge key (firebill route only): a caller retry or re-run
        // job with the same chargeId dedupes instead of double-billing.
        trackedInRequest = await autumnService.trackCredits({
          teamId: team_id,
          orgId: org_id,
          value: credits,
          properties: autumnProperties,
          featureId,
          idempotencyKey: billing.chargeId
            ? `fc:track:${billing.endpoint}:${billing.chargeId}`
            : undefined,
          externalRequestId: billing.externalRequestId ?? undefined,
        });
      } else if (team_id !== "preview" && !team_id.startsWith("preview_")) {
        // Preview teams are never tracked anyway; a real team arriving without
        // an org is not expected, and its usage is about to go unmetered.
        logger?.error(
          "No org for the team; not tracking to Autumn, so this usage is not recorded",
          { team_id, credits, billing },
        );
      }

      const result = await queueBillingOperation(
        team_id,
        org_id,
        credits,
        api_key_id,
        billing,
        false,
        trackedInRequest,
      );

      // No compensating refund: the tracked charge is durable and correct,
      // and a refund here poisons a retried request — its track would be
      // deduped against the same idempotency key (no new charge), leaving
      // Autumn net-zero for billed work.
      if (!result.success && trackedInRequest) {
        logger?.warn("billing enqueue failed; charge stands", {
          team_id,
          credits,
          billing,
        });
      }

      return result;
    },
    { success: true, message: "No DB, bypassed." },
  )(team_id, org_id, credits, api_key_id, billing, logger);
}
