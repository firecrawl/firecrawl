import { redisEvictConnection } from "../../services/redis";
import { logger as _logger } from "../logger";
import { CostTracking } from "./extraction-service";

export enum ExtractStep {
  INITIAL = "initial",
  MAP = "map",
  MAP_RERANK = "map-rerank",
  MULTI_ENTITY = "multi-entity",
  MULTI_ENTITY_SCRAPE = "multi-entity-scrape",
  MULTI_ENTITY_AGENT_SCRAPE = "multi-entity-agent-scrape",
  MULTI_ENTITY_EXTRACT = "multi-entity-extract",
  SCRAPE = "scrape",
  EXTRACT = "extract",
  COMPLETE = "complete",
}

export type ExtractedStep = {
  step: ExtractStep;
  startedAt: number;
  finishedAt: number | null;
  error?: any;
  discoveredLinks?: string[];
};

export type StoredExtract = {
  id: string;
  team_id: string;
  createdAt: number;
  status: "processing" | "completed" | "failed" | "cancelled";
  error?: any;
  showSteps?: boolean;
  steps?: ExtractedStep[];
  showLLMUsage?: boolean;
  showSources?: boolean;
  llmUsage?: number;
  showCostTracking?: boolean;
  costTracking?: CostTracking;
  sources?: {
    [key: string]: string[];
  };
  sessionIds?: string[];
  tokensBilled?: number;
  zeroDataRetention?: boolean;
};

// Reduce TTL to 6 hours instead of 24
const EXTRACT_TTL = 6 * 60 * 60;

const STEPS_MAX_DISCOVERED_LINKS = 100;

export async function saveExtract(id: string, extract: StoredExtract) {
  _logger.debug("Saving extract " + id + " to Redis...");
  // Only store essential data
  const minimalExtract = {
    ...extract,
    steps: extract.steps?.map(step => ({
      step: step.step,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      error: step.error,
      // Only store first 20 discovered links per step
      discoveredLinks: step.discoveredLinks?.slice(0, STEPS_MAX_DISCOVERED_LINKS)
    }))
  };
  await redisEvictConnection.set("extract:" + id, JSON.stringify(minimalExtract));
  await redisEvictConnection.expire("extract:" + id, EXTRACT_TTL);
}

export async function getExtract(id: string): Promise<StoredExtract | null> {
  const x = await redisEvictConnection.get("extract:" + id);
  return x ? JSON.parse(x) : null;
}

export async function updateExtract(
  id: string,
  extract: Partial<StoredExtract>,
) {
  const current = await getExtract(id);
  if (!current) return;

  // Handle steps aggregation with cleanup
  if (extract.steps && current.steps) {
    // Keep only the last 5 steps to prevent unbounded growth
    const allSteps = [...current.steps, ...extract.steps];
    extract.steps = allSteps.slice(Math.max(0, allSteps.length - 5));
  }

  // Limit links in steps to 20 instead of 100 to reduce memory usage
  if (extract.steps) {
    extract.steps = extract.steps.map((step) => {
      if (step.discoveredLinks && step.discoveredLinks.length > STEPS_MAX_DISCOVERED_LINKS) {
        return {
          ...step,
          discoveredLinks: step.discoveredLinks.slice(0, STEPS_MAX_DISCOVERED_LINKS),
        };
      }
      return step;
    });
  }

  const minimalExtract = {
    ...current,
    ...extract,
    steps: extract.steps?.map(step => ({
      step: step.step,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      error: step.error,
      discoveredLinks: step.discoveredLinks?.slice(0, STEPS_MAX_DISCOVERED_LINKS)
    }))
  };

  console.log(minimalExtract.sessionIds)

  await redisEvictConnection.set("extract:" + id, JSON.stringify(minimalExtract));
  await redisEvictConnection.expire("extract:" + id, EXTRACT_TTL);
}

export async function getExtractExpiry(id: string): Promise<Date> {
  const d = new Date();
  const ttl = await redisEvictConnection.pttl("extract:" + id);
  d.setMilliseconds(d.getMilliseconds() + ttl);
  d.setMilliseconds(0);
  return d;
}
