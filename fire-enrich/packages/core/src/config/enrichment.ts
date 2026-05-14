/**
 * Enrichment configuration
 */

export const ENRICHMENT_CONFIG = {
  /**
   * Number of rows to process concurrently
   * Higher values = faster processing but more API usage
   * Recommended: 2-5 for most use cases
   */
  CONCURRENT_ROWS: 10,

  /**
   * Delay between batches (milliseconds)
   * Helps prevent rate limiting
   */
  BATCH_DELAY_MS: 1000,
} as const;
