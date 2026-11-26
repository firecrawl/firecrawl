import { configDotenv } from "dotenv";
import { EngineForcingMatcher } from "@mendable/firecrawl-rs";
import { Engine } from "../../scrapeURL/engines";
import { logger } from "../../../lib/logger";

import { config } from "../../../config";
configDotenv();

type EngineForcingMapping = {
  [domain: string]: Engine | Engine[];
};

let engineMatcher: EngineForcingMatcher | null = null;
let engineValues: (Engine | Engine[])[] = [];

/**
 * Initialize the engine forcing mappings from environment variable
 * Expected format: JSON object with domain patterns as keys and engines as values
 * Example: {"example.com": "playwright", "*.google.com": ["fire-engine;chrome-cdp", "playwright"]}
 */
export function initializeEngineForcing() {
  const envVar = config.FORCED_ENGINE_DOMAINS;

  if (!envVar || envVar.trim() === "") {
    engineMatcher = null;
    engineValues = [];
    return;
  }

  try {
    const parsed = JSON.parse(envVar) as EngineForcingMapping | null;
    if (!parsed || typeof parsed !== "object") {
      engineMatcher = null;
      engineValues = [];
      return;
    }

    const entries = Object.entries(parsed);
    if (entries.length === 0) {
      engineMatcher = null;
      engineValues = [];
      return;
    }

    engineMatcher = new EngineForcingMatcher(
      entries.map(([pattern]) => pattern),
    );
    engineValues = entries.map(([, engine]) => engine);
  } catch (error) {
    logger.error("Error parsing FORCED_ENGINE_DOMAINS environment variable", {
      error,
    });
    engineMatcher = null;
    engineValues = [];
  }
}

/**
 * Get the forced engine(s) for a given URL based on domain mappings
 * @param url The URL to check
 * @returns The forced engine(s) if a match is found, undefined otherwise
 */
export function getEngineForUrl(url: string): Engine | Engine[] | undefined {
  if (engineMatcher === null || engineValues.length === 0) {
    return undefined;
  }

  const matchIndex = engineMatcher.matchUrl(url);
  if (matchIndex === null) {
    return undefined;
  }

  return engineValues[matchIndex];
}
