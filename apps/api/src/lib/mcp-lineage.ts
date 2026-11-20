// Formats of the fields that tie a hosted MCP call to its session and
// conversation, shared by the MCP action log and stored feedback so both
// validate them the same way.
export const SECRET_PATTERN =
  /(?:\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk-|fc-|fco_|fcr_|fcmcp_)[A-Za-z0-9_-]+)/i;
export const OBJECTIVE_MAX_LENGTH = 1000;
export const LINEAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const SESSION_SOURCES = ["token", "trace", "sse"] as const;
export const THREAD_SOURCES = [
  "argument",
  "session",
  "minted",
  "client",
] as const;
export const LINEAGE_ID_SECRET_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:sk-|fc-|fco_|fcr_|fcmcp_)/i;
