// src/custom-tools/client.ts
// Shared FirecrawlApp factory for custom tools.
// Mirrors the self-hosted getClient() logic from src/index.ts.
// Do NOT import from src/index.ts — circular dependency.

import FirecrawlApp from '@mendable/firecrawl-js';
import type { SessionData } from './types.js';

/**
 * Creates a FirecrawlApp client configured for the self-hosted instance.
 * For self-hosted: FIRECRAWL_API_URL from env, API key optional.
 * Used by all custom tools (stories 2.2–2.6).
 *
 * Throws if neither FIRECRAWL_API_URL nor a session API key is provided —
 * prevents silent fallback to the cloud Firecrawl API which would exfiltrate
 * query data to a third-party service.
 */
export function createClient(session?: SessionData): FirecrawlApp {
  const apiUrl = process.env.FIRECRAWL_API_URL;
  const apiKey = session?.firecrawlApiKey;

  if (!apiUrl && !apiKey) {
    throw new Error(
      'FIRECRAWL_API_URL environment variable is not set. ' +
      'Set it to your self-hosted Firecrawl instance URL (e.g. https://your-firecrawl.example.com).'
    );
  }

  const config: Record<string, unknown> = {};
  if (apiUrl) config['apiUrl'] = apiUrl;
  if (apiKey) config['apiKey'] = apiKey;

  return new FirecrawlApp(config as any);
}
