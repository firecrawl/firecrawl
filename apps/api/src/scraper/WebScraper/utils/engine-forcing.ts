import { configDotenv } from "dotenv";
import { parse } from "tldts";
import { Engine } from "../../scrapeURL/engines";
import { logger } from "../../../lib/logger";

import { config } from "../../../config";
configDotenv();

type EngineForcingMapping = {
  [domain: string]: Engine | Engine[];
};

let engineMappings: EngineForcingMapping | null = null;

/**
 * Initialize the engine forcing mappings from environment variable
 * Expected format: JSON object with domain patterns as keys and engines as values
 * Example: {"example.com": "playwright", "*.google.com": ["fire-engine;chrome-cdp", "playwright"]}
 */
export function initializeEngineForcing() {
  const envVar = config.FORCED_ENGINE_DOMAINS;

  if (!envVar || envVar.trim() === "") {
    engineMappings = {};
    return;
  }

  try {
    engineMappings = JSON.parse(envVar);
  } catch (error) {
    logger.error("Error parsing FORCED_ENGINE_DOMAINS environment variable", {
      error,
    });
    engineMappings = {};
  }
}

/**
 * Check if a domain matches a pattern (supports wildcards)
 * @param domain The domain to check (e.g., "sub.example.com")
 * @param pattern The pattern to match against (e.g., "example.com" or "*.example.com")
 * @returns true if the domain matches the pattern
 */
function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (domain === pattern) {
    return true;
  }

  if (pattern.startsWith("*.")) {
    const basePattern = pattern.substring(2); // Remove "*."
    return domain === basePattern || domain.endsWith(`.${basePattern}`);
  }

  return domain === pattern || domain.endsWith(`.${pattern}`);
}

/**
 * Get the forced engine(s) for a given URL based on domain mappings
 * @param url The URL to check
 * @returns The forced engine(s) if a match is found, undefined otherwise
 */
export function getEngineForUrl(url: string): Engine | Engine[] | undefined {
  if (engineMappings === null) {
    return undefined;
  }

  if (Object.keys(engineMappings).length === 0) {
    return undefined;
  }

  const lowerCaseUrl = url.trim().toLowerCase();

  let parsedUrl: any;
  try {
    parsedUrl = parse(lowerCaseUrl);
  } catch (error) {
    logger.warn("Error parsing URL for engine forcing", { url, error });
    return undefined;
  }

  const domain = parsedUrl.domain;
  if (!domain) {
    return undefined;
  }

  for (const [pattern, engine] of Object.entries(engineMappings)) {
    if (domainMatchesPattern(domain, pattern.toLowerCase())) {
      return engine;
    }
  }

  return undefined;
}
