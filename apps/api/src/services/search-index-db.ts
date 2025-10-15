/**
 * Search Index Database Service
 * 
 * Separate Supabase client for the search index database.
 * This allows independent scaling and isolation from the main index DB.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger as _logger } from "../lib/logger";
import { configDotenv } from "dotenv";

configDotenv();

/**
 * SearchIndexSupabaseService - Manages connection to search index database
 */
class SearchIndexSupabaseService {
  private client: SupabaseClient | null = null;

  constructor() {
    const supabaseUrl = process.env.SEARCH_INDEX_SUPABASE_URL;
    const supabaseServiceToken = process.env.SEARCH_INDEX_SUPABASE_SERVICE_TOKEN;
    
    // Only initialize if both URL and token are provided
    if (!supabaseUrl || !supabaseServiceToken) {
      _logger.warn("Search index database not configured. Set SEARCH_INDEX_SUPABASE_URL and SEARCH_INDEX_SUPABASE_SERVICE_TOKEN to enable.");
      this.client = null;
    } else {
      this.client = createClient(supabaseUrl, supabaseServiceToken);
      _logger.info("Search index database client initialized", {
        url: supabaseUrl.substring(0, 30) + "...",
      });
    }
  }

  /**
   * Get the Supabase client for search index
   */
  getClient(): SupabaseClient | null {
    return this.client;
  }

  /**
   * Check if search index is enabled
   */
  isEnabled(): boolean {
    return this.client !== null;
  }
}

const searchIndexService = new SearchIndexSupabaseService();

/**
 * Proxy to provide clean error messages when search index is not configured
 */
export const search_index_supabase_service: SupabaseClient = new Proxy(
  searchIndexService,
  {
    get: function (target, prop, receiver) {
      const client = target.getClient();
      
      // If client is not initialized, throw immediately to prevent nested access errors
      if (client === null) {
        throw new Error(
          "Search index database is not configured. " +
          "Set SEARCH_INDEX_SUPABASE_URL and SEARCH_INDEX_SUPABASE_SERVICE_TOKEN environment variables."
        );
      }
      
      // Direct access to service properties
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      
      // Delegate to Supabase client
      return Reflect.get(client, prop, receiver);
    },
  }
) as unknown as SupabaseClient;

/**
 * Check if search index database is enabled
 */
export function isSearchIndexEnabled(): boolean {
  return (
    process.env.ENABLE_SEARCH_INDEX === "true" &&
    searchIndexService.isEnabled()
  );
}

/**
 * Get search index database client (throws if not configured)
 */
export function getSearchIndexClient(): SupabaseClient {
  const client = searchIndexService.getClient();
  if (!client) {
    throw new Error(
      "Search index database is not configured. " +
      "Set SEARCH_INDEX_SUPABASE_URL and SEARCH_INDEX_SUPABASE_SERVICE_TOKEN."
    );
  }
  return client;
}

