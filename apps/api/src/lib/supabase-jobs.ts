import { eq, inArray, and } from "drizzle-orm";
import { db, dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { logger } from "./logger";

/**
 * Get a single scrape by ID from the scrapes table
 * @param scrapeId ID of Scrape
 * @returns Scrape data or null
 */
export const supabaseGetScrapeById = async (scrapeId: string): Promise<any> => {
  try {
    const [data] = await dbRr
      .select()
      .from(schema.scrapes)
      .where(eq(schema.scrapes.id, scrapeId))
      .limit(1);
    return data ?? null;
  } catch (error) {
    return null;
  }
};

/**
 * Get a single scrape by ID from the primary database.
 * Use this when the scrape may have been created immediately before the read.
 */
export const supabaseGetScrapeByIdDirect = async (
  scrapeId: string,
): Promise<any> => {
  try {
    const [data] = await db
      .select()
      .from(schema.scrapes)
      .where(eq(schema.scrapes.id, scrapeId))
      .limit(1);
    return data ?? null;
  } catch (error) {
    logger.error("Error in supabaseGetScrapeByIdDirect", {
      error,
      scrapeId,
    });
    throw error;
  }
};

export const supabaseGetExtractByIdDirect = async (
  extractId: string,
): Promise<any> => {
  try {
    const [data] = await db
      .select()
      .from(schema.extracts)
      .where(eq(schema.extracts.id, extractId))
      .limit(1);
    return data ?? null;
  } catch (error) {
    return null;
  }
};

export const supabaseGetExtractRequestByIdDirect = async (
  extractId: string,
): Promise<typeof schema.requests.$inferSelect | null> => {
  try {
    const [data] = await db
      .select()
      .from(schema.requests)
      .where(
        and(
          eq(schema.requests.id, extractId),
          inArray(schema.requests.kind, ["extract", "agent"]),
        ),
      )
      .limit(1);
    return data ?? null;
  } catch (error) {
    return null;
  }
};

export const supabaseGetAgentRequestByIdDirect = async (
  agentId: string,
): Promise<typeof schema.requests.$inferSelect | null> => {
  try {
    const [data] = await db
      .select()
      .from(schema.requests)
      .where(
        and(eq(schema.requests.id, agentId), eq(schema.requests.kind, "agent")),
      )
      .limit(1);
    return data ?? null;
  } catch (error) {
    return null;
  }
};

export const supabaseGetCrawlRequestById = async (requestId: string) => {
  const [data] = await dbRr
    .select({
      team_id: schema.requests.team_id,
      kind: schema.requests.kind,
      created_at: schema.requests.created_at,
    })
    .from(schema.requests)
    .where(
      and(
        eq(schema.requests.id, requestId),
        inArray(schema.requests.kind, ["crawl", "batch_scrape"]),
      ),
    )
    .limit(1);
  return data ?? null;
};

export const supabaseGetAgentByIdDirect = async (
  agentId: string,
): Promise<any> => {
  try {
    const [data] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .limit(1);
    return data ?? null;
  } catch (error) {
    return null;
  }
};
