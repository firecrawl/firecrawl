import { and, eq, gte } from "drizzle-orm";
import { dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { FeedbackLogger } from "./internal-types";

function startOfUtcDay(now: Date = new Date()): Date {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export async function sumCreditsRefundedToday(
  dbTeamId: string,
  logger: FeedbackLogger,
): Promise<number> {
  const since = startOfUtcDay().toISOString();

  try {
    const data = await dbRr
      .select({ credits_refunded: schema.search_feedback.credits_refunded })
      .from(schema.search_feedback)
      .where(
        and(
          eq(schema.search_feedback.team_id, dbTeamId),
          gte(schema.search_feedback.created_at, since),
        ),
      );

    return data.reduce((sum, row) => sum + (row.credits_refunded ?? 0), 0);
  } catch (error) {
    logger.warn(
      "Failed to compute feedback refund total; allowing refund this call",
      { error },
    );
    return 0;
  }
}
