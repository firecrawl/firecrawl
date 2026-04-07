import { withAuth } from "../../lib/withAuth";
import { queueBillingOperation } from "./batch_billing";
import { type BillingMetadata } from "./types";
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
      _logger: Logger | undefined,
    ) => {
      return queueBillingOperation(
        team_id,
        subscription_id,
        credits,
        api_key_id,
        billing,
        false,
      );
    },
    { success: true, message: "No DB, bypassed." },
  )(team_id, subscription_id, credits, api_key_id, billing, logger);
}
