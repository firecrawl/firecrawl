import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { config } from "../../config";
import { logger } from "../logger";
import { normalizeUrl, normalizeUrlOnlyHostname } from "../canonical-url";

interface LlmsTextCache {
  origin_url: string;
  llmstxt: string;
  llmstxt_full: string;
  max_urls: number;
}

export async function getLlmsTextFromCache(
  url: string,
  maxUrls: number,
): Promise<LlmsTextCache | null> {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return null;
  }

  const originUrl = normalizeUrlOnlyHostname(url);

  try {
    const [data] = await db
      .select()
      .from(schema.llm_texts)
      .where(
        and(
          eq(schema.llm_texts.origin_url, originUrl),
          gte(schema.llm_texts.max_urls, maxUrls), // gte since we want cached results with more URLs than requested
        ),
      )
      .orderBy(desc(schema.llm_texts.updated_at))
      .limit(1);

    // Check if data is older than 1 week
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    if (!data || !data.updated_at || new Date(data.updated_at) < oneWeekAgo) {
      return null;
    }

    return data as LlmsTextCache;
  } catch (error) {
    logger.error("Failed to fetch LLMs text from cache", { error, originUrl });
    return null;
  }
}

export async function saveLlmsTextToCache(
  url: string,
  llmstxt: string,
  llmstxt_full: string,
  maxUrls: number,
): Promise<void> {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return;
  }

  const originUrl = normalizeUrlOnlyHostname(url);

  try {
    // First check if there's an existing entry
    const [existingData] = await db
      .select({ id: schema.llm_texts.id })
      .from(schema.llm_texts)
      .where(eq(schema.llm_texts.origin_url, originUrl))
      .limit(1);

    if (existingData) {
      // Update existing entry
      try {
        await db
          .update(schema.llm_texts)
          .set({
            llmstxt,
            llmstxt_full,
            max_urls: maxUrls,
            updated_at: new Date().toISOString(),
          })
          .where(eq(schema.llm_texts.origin_url, originUrl));
        logger.debug("Successfully updated cached LLMs text", {
          originUrl,
          maxUrls,
        });
      } catch (error) {
        logger.error("Error updating LLMs text in cache", { error, originUrl });
      }
    } else {
      // Insert new entry
      try {
        await db.insert(schema.llm_texts).values({
          origin_url: originUrl,
          llmstxt,
          llmstxt_full,
          max_urls: maxUrls,
          updated_at: new Date().toISOString(),
        });
        logger.debug("Successfully inserted new cached LLMs text", {
          originUrl,
          maxUrls,
        });
      } catch (error) {
        logger.error("Error inserting LLMs text to cache", {
          error,
          originUrl,
        });
      }
    }
  } catch (error) {
    logger.error("Failed to save LLMs text to cache", { error, originUrl });
  }
}
