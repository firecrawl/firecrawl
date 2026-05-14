// src/custom-tools/types.ts
// Shared types for custom Firecrawl MCP tools.
// Import from here in every custom tool file to avoid circular deps with src/index.ts.

import type { FastMCP } from 'firecrawl-fastmcp';

/**
 * Mirror of SessionData from src/index.ts.
 * Redefined here to avoid circular imports — must stay in sync if index.ts changes.
 */
export interface SessionData {
  firecrawlApiKey?: string;
  [key: string]: unknown;
}

/**
 * Convenience alias used in every custom tool's register() function signature.
 * Usage: export function register(server: MCP): void { ... }
 */
export type MCP = FastMCP<SessionData>;
