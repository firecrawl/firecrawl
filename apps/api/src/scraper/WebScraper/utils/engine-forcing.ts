import { configDotenv } from "dotenv";
import { parse } from "tldts";
import { z } from "zod";
import type { Engine } from "../../scrapeURL/engines";
import { jsonObjectSchema } from "../../../lib/json-types";
import { logger } from "../../../lib/logger";

import { config } from "../../../config";
configDotenv();

const engineSchema = z.custom<Engine>(
  value => typeof value === "string" && value.length > 0,
);

const engineForcingEntrySchema = z.union([engineSchema, z.array(engineSchema)]);

type EngineForcingEntry = z.infer<typeof engineForcingEntrySchema>;

let engineMappings: Map<string, EngineForcingEntry> | null = null;

function parseEngineForcingMappings(
  raw: unknown,
): Map<string, EngineForcingEntry> {
  const mappings = new Map<string, EngineForcingEntry>();
  const parsedRoot = jsonObjectSchema.safeParse(raw);
  if (!parsedRoot.success) {
    logger.warn(
      "FORCED_ENGINE_DOMAINS must be a JSON object mapping domains to engines",
    );
    return mappings;
  }
  for (const [domain, value] of Object.entries(parsedRoot.data)) {
    const parsedEntry = engineForcingEntrySchema.safeParse(value);
    if (parsedEntry.success) {
      mappings.set(domain, parsedEntry.data);
    } else {
      logger.warn("Ignoring invalid FORCED_ENGINE_DOMAINS entry", { domain });
    }
  }
  return mappings;
}

/**
 * Initialize the engine forcing mappings from environment variable
 * Expected format: JSON object with domain patterns as keys and engines as values
 * Example: {"example.com": "playwright", "*.google.com": ["fire-engine;chrome-cdp", "playwright"]}
 */
export function initializeEngineForcing() {
  const envVar = config.FORCED_ENGINE_DOMAINS;

  if (!envVar || envVar.trim() === "") {
    engineMappings = new Map();
    return;
  }

  try {
    const parsed: unknown = JSON.parse(envVar);
    engineMappings = parseEngineForcingMappings(parsed);
  } catch (error: unknown) {
    logger.error("Error parsing FORCED_ENGINE_DOMAINS environment variable", {
      error,
    });
    engineMappings = new Map();
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
    const basePattern = pattern.slice(2); // Remove "*."
    return domain === basePattern || domain.endsWith(`.${basePattern}`);
  }

  return domain === pattern || domain.endsWith(`.${pattern}`);
}

/**
 * Get the forced engine(s) for a given URL based on domain mappings
 * @param url The URL to check
 * @returns The forced engine(s) if a match is found, undefined otherwise
 */
export function getEngineForUrl(
  url: string,
): Engine | Array<Engine> | undefined {
  if (engineMappings === null || engineMappings.size === 0) {
    return undefined;
  }

  const lowerCaseUrl = url.trim().toLowerCase();

  let parsedUrl: ReturnType<typeof parse>;
  try {
    parsedUrl = parse(lowerCaseUrl);
  } catch (error: unknown) {
    logger.warn("Error parsing URL for engine forcing", { url, error });
    return undefined;
  }

  const domain = parsedUrl.domain;
  if (!domain) {
    return undefined;
  }

  for (const [pattern, engine] of engineMappings) {
    if (domainMatchesPattern(domain, pattern.toLowerCase())) {
      return engine;
    }
  }

  return undefined;
}
