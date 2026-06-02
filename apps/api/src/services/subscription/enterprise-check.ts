import { and, eq, gt } from "drizzle-orm";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";

const RATE_LIMIT_CHANGE_NOTIFICATION_START_DATE = new Date("2025-03-12");

export async function isEnterpriseTeamCreatedAfterRateLimitChange(
  team_id: string,
): Promise<boolean> {
  try {
    const data = await db
      .select({ is_enterprise: schema.products.is_enterprise })
      .from(schema.subscriptions)
      .innerJoin(
        schema.prices,
        eq(schema.subscriptions.price_id, schema.prices.id),
      )
      .innerJoin(
        schema.products,
        eq(schema.prices.product_id, schema.products.id),
      )
      .where(
        and(
          eq(schema.subscriptions.status, "active"),
          eq(schema.subscriptions.team_id, team_id),
          gt(
            schema.subscriptions.created,
            RATE_LIMIT_CHANGE_NOTIFICATION_START_DATE.toISOString(),
          ),
        ),
      );

    return data.some(sub => sub.is_enterprise === true);
  } catch (error) {
    // If there's an error or no subscription found, assume non-enterprise
    return false;
  }
}
