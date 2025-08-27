/**
 * This file defines the data schemas for events tracked in the ledger system.
 * These interfaces represent the structure of the 'data' JSONB column in ledger.tracks.
 */

/**
 * Common properties shared across all events
 */
export interface BaseEventData {
    user_id?: string; // User ID if available
    team_id?: string; // Team ID if available
  }
  
  /**
   * Concurrent browser limit reached event data
   * Tracks when a user reaches the concurrent browser limit
   */
  export interface ConcurrentBrowserLimitReachedEventData extends BaseEventData {
    team_id: string; // The team ID
  }
  /**
   * Map of event definition slugs to their data types
   */
  export interface EventDataMap {
    "concurrent-browser-limit-reached": ConcurrentBrowserLimitReachedEventData;
  }
  
  /**
   * Event definition slugs
   */
  export type EventDefinitionSlug = keyof EventDataMap;
  
  /**
   * Helper type to extract the data type for a specific event
   */
  export type EventData<T extends EventDefinitionSlug> = EventDataMap[T];
  
  /**
   * Creates a properly typed event data object with current timestamp
   */
  export function createEventData<T extends EventDefinitionSlug>(
    eventType: T,
    data: EventDataMap[T],
  ): EventDataMap[T] {
    return {
      ...data,
    } as EventDataMap[T];
  }
  