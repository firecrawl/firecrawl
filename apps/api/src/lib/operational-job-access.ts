import { isUuidV7Id } from "./bigtable-row-key";
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
 * fetchable life; there is no other store to ask. A failed read is an
 * outage, not a missing job: it is rethrown so the caller answers an error
 * rather than a 404 for a job that exists.
 */
async function resolveOperationalJobAccess(params: {
  id: string;
  kinds: readonly ApiJobKind[];
}): Promise<OperationalJobAccess | null> {
  // An id that is not a UUIDv7 names no row: not found, not an outage.
  if (!isUuidV7Id(params.id)) return null;
  let access: ApiJobAccess | null;
  try {
    access = await readApiJobAccess(params.id);
  } catch (error) {
    logger.error("Bigtable job access read failed", {
      error,
      jobId: params.id,
    });
    throw error;
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
