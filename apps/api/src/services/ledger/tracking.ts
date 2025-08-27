import { EventDataMap, EventDefinitionSlug } from "./data-schemas";
// @ts-nocheck - Schema not in types_db yet
import { supabase_ledger_service } from "./supabase-ledger";
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
      const result = await supabase_ledger_service
        .from("provider_definitions")
        .select("id")
        .eq("slug", definitionSlug)
        .single();

      definitionError = result.error;
      providerDefinition = result.data;

      // Cache the result for 24 hours (1440 minutes)
      if (!definitionError && providerDefinition) {
        await setValue(cacheKey, JSON.stringify(providerDefinition), 600 * 60 * 24);
      }
    }

    if (definitionError || !providerDefinition) {
      logger.error("Error finding provider definition:", definitionError);
      return null;
    }

    // Create the track
    const { data: track, error: trackError } = await supabase_ledger_service
      .from("tracks")
      //@ts-ignore
      .insert({
        created_at: new Date().toISOString(),
        //@ts-ignore
        provider_definition_id: providerDefinition.id,
        data: data,
      })
      .select("uuid")
      .single();

    if (trackError || !track) {
      logger.error("Error creating track:", trackError);
      return null;
    }
    //@ts-ignore
    return track.uuid;
  } catch (error) {
    logger.error("Error tracking event:", error);
    return null;
  }
}

// data schemas?
// everything that sends an email, move to tracks
