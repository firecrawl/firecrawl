import { eq } from "drizzle-orm";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";

export type CostTrackingCall = {
  model: string;
  cost: number;
  metadata: Record<string, unknown>;
  tokens?: { input: number; output: number };
};

// The scrape row is written when the job finishes; give the insert a moment.
export async function getCostTrackingCalls(
  scrapeId: string,
): Promise<CostTrackingCall[]> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const rows = await db
      .select({ cost_tracking: schema.scrapes.cost_tracking })
      .from(schema.scrapes)
      .where(eq(schema.scrapes.id, scrapeId))
      .limit(1);
    if (rows.length === 1) {
      const costTracking = rows[0].cost_tracking as {
        calls?: CostTrackingCall[];
      } | null;
      return costTracking?.calls ?? [];
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`No scrapes row for ${scrapeId}`);
}
