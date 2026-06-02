import { EventDataMap, EventDefinitionSlug } from "./data-schemas";
import { eq } from "drizzle-orm";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { getValue, setValue } from "../redis";
import { logger } from "../../lib/logger";

/**
 * Track an event in the ledger system
 * @param definitionSlug The provider definition slug
 * @param data Additional data to store with the track
 * @returns The tracked event ID or null if tracking failed
 */
export async function trackEvent<T extends EventDefinitionSlug>(
  definitionSlug: T,
  data: EventDataMap[T],
): Promise<string | null> {
  try {
    // Get the provider definition ID from cache or database
    const cacheKey = `provider_definition_${definitionSlug}_`;
    let providerDefinition: any = null;
    let definitionError: any = null;

    // Try to get from Redis cache first
    const cachedData = await getValue(cacheKey);
    if (cachedData) {
      providerDefinition = JSON.parse(cachedData);
    } else {
      // If not in cache, fetch from database
      try {
        [providerDefinition] = await db
          .select({ id: schema.provider_definitions.id })
          .from(schema.provider_definitions)
          .where(eq(schema.provider_definitions.slug, definitionSlug))
          .limit(1);
      } catch (error) {
        definitionError = error;
      }

      // Cache the result for 24 hours (1440 minutes)
      if (!definitionError && providerDefinition) {
        await setValue(
          cacheKey,
          JSON.stringify(providerDefinition),
          600 * 60 * 24,
        );
      }
    }

    if (definitionError || !providerDefinition) {
      logger.error("Error finding provider definition:", definitionError);
      return null;
    }

    // Create the track
    let track: { uuid: string } | undefined;
    try {
      [track] = await db
        .insert(schema.tracks)
        .values({
          created_at: new Date().toISOString(),
          provider_definition_id: providerDefinition.id,
          data: data,
        })
        .returning({ uuid: schema.tracks.uuid });
    } catch (trackError) {
      logger.error("Error creating track:", trackError);
      return null;
    }

    if (!track) {
      return null;
    }
    return track.uuid;
  } catch (error) {
    logger.error("Error tracking event:", error);
    return null;
  }
}

// data schemas?
// everything that sends an email, move to tracks
