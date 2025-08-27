import { redisEvictConnection } from "../../services/redis";
import { logger as _logger } from "../logger";

export interface GenerationData {
  id: string;
  team_id: string;
  createdAt: number;
  status: "processing" | "completed" | "failed";
  url: string;
  maxUrls: number;
  showFullText: boolean;
  cache?: boolean;
  generatedText: string;
  fullText: string;
  error?: string;
}

// TTL of 24 hours
const GENERATION_TTL = 24 * 60 * 60;

export async function saveGeneratedLlmsTxt(id: string, data: GenerationData): Promise<void> {
  _logger.debug("Saving llmstxt generation " + id + " to Redis...");
  await redisEvictConnection.set("generation:" + id, JSON.stringify(data));
  await redisEvictConnection.expire("generation:" + id, GENERATION_TTL);
}

export async function getGeneratedLlmsTxt(id: string): Promise<GenerationData | null> {
  const x = await redisEvictConnection.get("generation:" + id);
  return x ? JSON.parse(x) : null;
}

export async function updateGeneratedLlmsTxt(
  id: string,
  data: Partial<GenerationData>,
): Promise<void> {
  const current = await getGeneratedLlmsTxt(id);
  if (!current) return;

  const updatedGeneration = {
    ...current,
    ...data
  };

  await redisEvictConnection.set("generation:" + id, JSON.stringify(updatedGeneration));
  await redisEvictConnection.expire("generation:" + id, GENERATION_TTL);
}

export async function getGeneratedLlmsTxtExpiry(id: string): Promise<Date> {
  const d = new Date();
  const ttl = await redisEvictConnection.pttl("generation:" + id);
  d.setMilliseconds(d.getMilliseconds() + ttl);
  d.setMilliseconds(0);
  return d;
}

// Convenience method for status updates
export async function updateGeneratedLlmsTxtStatus(
  id: string,
  status: "processing" | "completed" | "failed",
  generatedText?: string,
  fullText?: string,
  error?: string,
): Promise<void> {
  const updates: Partial<GenerationData> = { status };
  if (generatedText !== undefined) updates.generatedText = generatedText;
  if (fullText !== undefined) updates.fullText = fullText;
  if (error !== undefined) updates.error = error;
  
  await updateGeneratedLlmsTxt(id, updates);
}    