import type { Logger } from "winston";
import { eq, inArray, and } from "drizzle-orm";
import { db, dbRr } from "../db/connection";
import * as schema from "../db/schema";

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
 * Get only team_id from a scrape by ID (lightweight query)
 * @param scrapeId ID of Scrape
 * @param logger Optional logger for error reporting
 * @returns Object with team_id or null
 */
export const supabaseGetScrapeByIdOnlyData = async (
  scrapeId: string,
  log?: Logger,
): Promise<any> => {
  try {
    const [data] = await dbRr
      .select({ team_id: schema.scrapes.team_id })
      .from(schema.scrapes)
      .where(eq(schema.scrapes.id, scrapeId))
      .limit(1);
    return data ?? null;
  } catch (error) {
    if (log) {
      log.error("Error in supabaseGetScrapeByIdOnlyData", { error });
    }
    return null;
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
): Promise<any> => {
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
): Promise<any> => {
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
