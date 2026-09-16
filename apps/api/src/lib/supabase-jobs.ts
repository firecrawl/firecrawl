import type { Logger } from "winston";
import { eq, inArray, and } from "drizzle-orm";
import { db, dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { readApiJobAccess } from "./job-access-store";
import type { ApiJobAccess, ApiJobKind } from "./job-access-store";
import { logger } from "./logger";

async function getOperationalJobAccess(
  id: string,
  kinds: readonly ApiJobKind[],
): Promise<ApiJobAccess | null | undefined> {
  try {
    const access = await readApiJobAccess(id);
    if (!access) return undefined;
    return kinds.includes(access.kind) ? access : null;
  } catch (error) {
    logger.warn("Bigtable job access read failed; falling back to PostgreSQL", {
      error,
      jobId: id,
    });
    return undefined;
  }
}

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

/**
 * Get multiple scrapes by ID from the scrapes table
 * @param scrapeIds IDs of Scrapes
 * @returns Scrape data array
 */
export const supabaseGetScrapesById = async (
  scrapeIds: string[],
): Promise<any[]> => {
  try {
    return await dbRr
      .select()
      .from(schema.scrapes)
      .where(inArray(schema.scrapes.id, scrapeIds));
  } catch (error) {
    logger.error(`Error in supabaseGetScrapesById: ${error}`);
    return [];
  }
};

/**
 * Get multiple scrapes by request ID (crawl/batch scrape ID) from the scrapes table
 * @param requestId ID of the parent request (crawl or batch scrape)
 * @returns Scrape data array
 */
export const supabaseGetScrapesByRequestId = async (
  requestId: string,
): Promise<any[]> => {
  try {
    return await dbRr
      .select()
      .from(schema.scrapes)
      .where(eq(schema.scrapes.request_id, requestId));
  } catch (error) {
    logger.error(`Error in supabaseGetScrapesByRequestId: ${error}`);
    return [];
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
    const access = await getOperationalJobAccess(scrapeId, ["scrape"]);
    if (access) {
      return access.expiresAtMs > Date.now()
        ? { team_id: access.teamId }
        : null;
    }
    if (access === null) return null;

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
    const access = await getOperationalJobAccess(extractId, [
      "extract",
      "agent",
    ]);
    if (access) {
      if (access.expiresAtMs <= Date.now()) return null;
      return {
        id: extractId,
        team_id: access.teamId,
        kind: access.kind,
        origin: access.clientOrigin ?? null,
        created_at: new Date(
          access.expiresAtMs - 24 * 60 * 60 * 1000,
        ).toISOString(),
      };
    }
    if (access === null) return null;

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
    const access = await getOperationalJobAccess(agentId, ["agent"]);
    if (access) {
      if (access.expiresAtMs <= Date.now()) return null;
      return {
        id: agentId,
        team_id: access.teamId,
        kind: access.kind,
        origin: access.clientOrigin ?? null,
      };
    }
    if (access === null) return null;

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

export type OperationalCrawlRequest = {
  team_id: string;
  created_at: Date | string | null;
  expires_at_ms?: number;
};

export const getOperationalCrawlRequest = async (
  id: string,
): Promise<OperationalCrawlRequest | null> => {
  const access = await getOperationalJobAccess(id, ["crawl", "batch_scrape"]);
  if (access) {
    return {
      team_id: access.teamId,
      created_at: null,
      expires_at_ms: access.expiresAtMs,
    };
  }
  if (access === null) return null;

  const [request] = await dbRr
    .select({
      team_id: schema.requests.team_id,
      created_at: schema.requests.created_at,
    })
    .from(schema.requests)
    .where(
      and(
        eq(schema.requests.id, id),
        inArray(schema.requests.kind, ["crawl", "batch_scrape"]),
      ),
    )
    .limit(1);
  return request ?? null;
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
