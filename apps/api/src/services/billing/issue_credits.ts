import { logger } from "../../lib/logger";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";

export async function issueCredits(team_id: string, credits: number) {
  try {
    await db.insert(schema.coupons).values({
      team_id: team_id,
      credits: credits,
      status: "active",
      // indicates that this coupon was issued from auto recharge
      from_auto_recharge: true,
      initial_credits: credits,
    });
  } catch (error) {
    logger.error(`Error adding coupon: ${error}`);
    return false;
  }

  return true;
}
