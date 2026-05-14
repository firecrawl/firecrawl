// Check if running in unlimited mode (when cloned/self-hosted)
const isUnlimitedMode =
  process.env.FIRE_ENRICH_UNLIMITED === "true" ||
  process.env.NODE_ENV === "development";

// Configuration for Fire Enrich
export const FIRE_ENRICH_CONFIG = {
  // CSV upload limits
  CSV_LIMITS: {
    MAX_ROWS: isUnlimitedMode ? Infinity : 15,
    MAX_COLUMNS: isUnlimitedMode ? Infinity : 5,
  },

  // Processing configuration
  PROCESSING: {
    DELAY_BETWEEN_ROWS_MS: 1000,
    MAX_RETRIES: 3,
  },

  // Request limits
  REQUEST_LIMITS: {
    MAX_BODY_SIZE_MB: isUnlimitedMode ? 50 : 5,
    MAX_FIELDS_PER_ENRICHMENT: isUnlimitedMode ? 50 : 10,
  },

  // Feature flags
  FEATURES: {
    IS_UNLIMITED: isUnlimitedMode,
  },
} as const;

// Error messages
export const ERROR_MESSAGES = {
  TOO_MANY_ROWS: `CSV file contains too many rows. Maximum allowed: ${FIRE_ENRICH_CONFIG.CSV_LIMITS.MAX_ROWS} rows`,
  TOO_MANY_COLUMNS: `CSV file contains too many columns. Maximum allowed: ${FIRE_ENRICH_CONFIG.CSV_LIMITS.MAX_COLUMNS} columns`,
  UPGRADE_PROMPT: isUnlimitedMode
    ? ""
    : "To process larger datasets with unlimited rows and columns, clone the repository and run it locally.",
} as const;
