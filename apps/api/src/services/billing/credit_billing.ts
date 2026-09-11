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
 * already answers for those teams — while the ledger enqueue, which needs no
 * org, still runs.
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
        });
      } else if (team_id !== "preview" && !team_id.startsWith("preview_")) {
        // Preview teams are never tracked anyway; a real team arriving without
        // an org is not expected, and its usage is about to go unmetered.
        logger?.error(
          "No org for the team; billing the ledger but not Autumn",
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

      // A track only happens with an org in hand; named again so the type says so.
      if (!result.success && trackedInRequest && org_id !== null) {
        if (await autumnService.isRoutedThroughFirebill(team_id, org_id)) {
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
            orgId: org_id,
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
  )(team_id, org_id, credits, api_key_id, billing, logger);
}
