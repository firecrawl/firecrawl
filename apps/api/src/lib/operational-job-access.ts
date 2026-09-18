import { logger } from "./logger";
import {
  readApiJobAccess,
  type ApiJobAccess,
  type ApiJobKind,
} from "./job-access-store";

type OperationalJobAccess = {
  teamId: string;
  kind: ApiJobKind;
  clientOrigin?: string;
  expiresAtMs: number;
};

/**
 * Who owns a job and until when it may be fetched, from the Bigtable job
 * access row that logRequest (and, for crawl and batch children, logScrape)
 * writes. A missing or expired row is the documented end of the job's
 * fetchable life; there is no other store to ask.
 */
async function resolveOperationalJobAccess(params: {
  id: string;
  kinds: readonly ApiJobKind[];
}): Promise<OperationalJobAccess | null> {
  let access: ApiJobAccess | null = null;
  try {
    access = await readApiJobAccess(params.id);
  } catch (error) {
    logger.warn("Bigtable job access read failed", {
      error,
      jobId: params.id,
    });
    return null;
  }
  if (!access) return null;
  return params.kinds.includes(access.kind) ? access : null;
}

export function getScrapeJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["scrape"] });
}

export function getExtractJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["extract", "agent"] });
}

export function getAgentJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["agent"] });
}

export function getCrawlJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({ id, kinds: ["crawl", "batch_scrape"] });
}
