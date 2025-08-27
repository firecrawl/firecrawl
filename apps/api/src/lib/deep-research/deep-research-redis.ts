import { redisEvictConnection } from "../../services/redis";
import { logger as _logger } from "../logger";

export enum DeepResearchStep {
  INITIAL = "initial",
  SEARCH = "search",
  EXTRACT = "extract",
  ANALYZE = "analyze",
  SYNTHESIS = "synthesis",
  COMPLETE = "complete"
}

export type DeepResearchActivity = {
  type: 'search' | 'extract' | 'analyze' | 'reasoning' | 'synthesis' | 'thought';
  status: 'processing' | 'complete' | 'error';
  message: string;
  timestamp: string;
  depth: number;
};

export type DeepResearchSource = {
  url: string;
  title: string;
  description: string;
};

export type DeepResearchFinding = {
  text: string;
  source: string;
};

export type StoredDeepResearch = {
  id: string;
  team_id: string;
  createdAt: number;
  status: "processing" | "completed" | "failed" | "cancelled";
  error?: any;
  currentDepth: number;
  maxDepth: number;
  completedSteps: number;
  totalExpectedSteps: number;
  findings: DeepResearchFinding[];
  sources: DeepResearchSource[];
  activities: DeepResearchActivity[];
  summaries: string[];
  finalAnalysis?: string;
  json?: any;
};

// TTL of 6 hours
const DEEP_RESEARCH_TTL = 6 * 60 * 60;

export async function saveDeepResearch(id: string, research: StoredDeepResearch) {
  _logger.debug("Saving deep research " + id + " to Redis...");
  await redisEvictConnection.set("deep-research:" + id, JSON.stringify(research));
  await redisEvictConnection.expire("deep-research:" + id, DEEP_RESEARCH_TTL);
}

export async function getDeepResearch(id: string): Promise<StoredDeepResearch | null> {
  const x = await redisEvictConnection.get("deep-research:" + id);
  return x ? JSON.parse(x) : null;
}

export async function updateDeepResearch(
  id: string,
  research: Partial<StoredDeepResearch>,
) {
  const current = await getDeepResearch(id);
  if (!current) return;

  const updatedResearch = {
    ...current,
    ...research,
    // Append new activities if provided
    activities: research.activities 
      ? [...(current.activities || []), ...research.activities]
      : current.activities,
    // Append new findings if provided  
    // findings: research.findings
    //   ? [...(current.findings || []), ...research.findings]
    //   : current.findings,
    // Append new sources if provided
    sources: research.sources
      ? [...(current.sources || []), ...research.sources]
      : current.sources,
    // Append new summaries if provided
    summaries: research.summaries
      ? [...(current.summaries || []), ...research.summaries]
      : current.summaries
  };

  

  await redisEvictConnection.set("deep-research:" + id, JSON.stringify(updatedResearch));
  await redisEvictConnection.expire("deep-research:" + id, DEEP_RESEARCH_TTL);
}

export async function getDeepResearchExpiry(id: string): Promise<Date> {
  const d = new Date();
  const ttl = await redisEvictConnection.pttl("deep-research:" + id);
  d.setMilliseconds(d.getMilliseconds() + ttl);
  d.setMilliseconds(0);
  return d;
} 