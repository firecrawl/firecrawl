import type { Logger } from "winston";
import { supabase_rr_service, supabase_service } from "../services/supabase";
import { logger } from "./logger";
import * as Sentry from "@sentry/node";

// ============================================================================
// NEW TABLES: scrapes, requests, crawls, etc.
// ============================================================================

/**
 * Get a single scrape by ID from the new scrapes table
 * @param scrapeId ID of Scrape
 * @returns Scrape data or null
 */
export const supabaseGetScrapeById = async (scrapeId: string) => {
  const { data, error } = await supabase_rr_service
    .from("scrapes")
    .select("*")
    .eq("id", scrapeId)
    .single();

  if (error) {
    return null;
  }

  if (!data) {
    return null;
  }

  return data;
};

/**
 * Get multiple scrapes by ID from the new scrapes table
 * @param scrapeIds IDs of Scrapes
 * @returns Scrape data array
 */
export const supabaseGetScrapesById = async (scrapeIds: string[]) => {
  const { data, error } = await supabase_rr_service
    .from("scrapes")
    .select()
    .in("id", scrapeIds);

  if (error) {
    logger.error(`Error in supabaseGetScrapesById: ${error}`);
    Sentry.captureException(error);
    return [];
  }

  if (!data) {
    return [];
  }

  return data;
};

/**
 * Get multiple scrapes by request ID (crawl/batch scrape ID) from the new scrapes table
 * @param requestId ID of the parent request (crawl or batch scrape)
 * @returns Scrape data array
 */
export const supabaseGetScrapesByRequestId = async (requestId: string) => {
  const { data, error } = await supabase_rr_service
    .from("scrapes")
    .select()
    .eq("request_id", requestId);

  if (error) {
    logger.error(`Error in supabaseGetScrapesByRequestId: ${error}`);
    Sentry.captureException(error);
    return [];
  }

  if (!data) {
    return [];
  }

  return data;
};

/**
 * Get only team_id from a scrape by ID (lightweight query)
 * @param scrapeId ID of Scrape
 * @param logger Optional logger for error reporting
 * @returns Object with team_id or null
 */
export const supabaseGetScrapeByIdOnlyData = async (
  scrapeId: string,
  logger?: Logger,
) => {
  const { data, error } = await supabase_rr_service
    .from("scrapes")
    .select("team_id")
    .eq("id", scrapeId)
    .single();

  if (error) {
    if (logger) {
      logger.error("Error in supabaseGetScrapeByIdOnlyData", { error });
    }
    return null;
  }

  if (!data) {
    return null;
  }

  return data;
};

export const supabaseGetExtractByIdDirect = async (extractId: string) => {
  const { data, error } = await supabase_service
    .from("extracts")
    .select("*")
    .eq("id", extractId)
    .single();

  if (error) {
    return null;
  }

  if (!data) {
    return null;
  }

  return data;
};
