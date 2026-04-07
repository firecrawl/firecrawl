import { withAuth } from "../../lib/withAuth";
import { queueBillingOperation } from "./batch_billing";
import { autumnService } from "../autumn/autumn.service";
import { toAutumnBillingProperties, type BillingMetadata } from "./types";
import type { Logger } from "winston";

/**
 * If you do not know the subscription_id in the current context, pass subscription_id as undefined.
 */
export async function billTeam(
  team_id: string,
  subscription_id: string | null | undefined,
  credits: number,
  api_key_id: number | null,
  billing: BillingMetadata,
  logger?: Logger,
) {
  return withAuth(
    async (
      team_id: string,
      subscription_id: string | null | undefined,
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
      const trackedInRequest = await autumnService.trackCredits({
        teamId: team_id,
        value: credits,
        properties: autumnProperties,
        requestScoped: true,
      });

      const result = await queueBillingOperation(
        team_id,
        subscription_id,
        credits,
        api_key_id,
        billing,
        false,
        trackedInRequest,
      );

      if (!result.success && trackedInRequest) {
        await autumnService.refundCredits({
          teamId: team_id,
          value: credits,
          properties: autumnProperties,
        });
      }

      return result;
    },
    { success: true, message: "No DB, bypassed." },
  )(team_id, subscription_id, credits, api_key_id, billing, logger);
}
