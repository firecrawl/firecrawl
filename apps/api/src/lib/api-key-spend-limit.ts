import { eq } from "drizzle-orm";
import { dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { logger } from "./logger";

export type ApiKeySpendLimit = { credits: number; interval: string };

/**
 * The per-API-key spend limit set in the dashboard, or null when the key has
 * none or it can't be read. Only used to explain a refusal, so it fails soft.
 */
export async function getApiKeySpendLimit(
  apiKeyId: number,
): Promise<ApiKeySpendLimit | null> {
  try {
    const [row] = await dbRr
      .select({
        credits: schema.api_keys.credit_limit,
        interval: schema.api_keys.credit_limit_interval,
      })
      .from(schema.api_keys)
      .where(eq(schema.api_keys.id, apiKeyId))
      .limit(1);
    if (typeof row?.credits !== "number" || !row.interval) return null;
    return { credits: row.credits, interval: row.interval };
  } catch (error) {
    logger.warn("Failed to load API key spend limit", { apiKeyId, error });
    return null;
  }
}
