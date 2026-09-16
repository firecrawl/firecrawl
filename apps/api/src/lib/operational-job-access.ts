import { logger } from "./logger";
import {
  readApiJobAccess,
  type ApiJobAccess,
  type ApiJobKind,
} from "./job-access-store";
import {
  supabaseGetAgentRequestByIdDirect,
  supabaseGetCrawlRequestById,
  supabaseGetExtractRequestByIdDirect,
  supabaseGetScrapeById,
} from "./supabase-jobs";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export type OperationalJobAccess = {
  teamId: string;
  kind: ApiJobKind;
  clientOrigin?: string;
  expiresAtMs: number;
};

async function resolveOperationalJobAccess(params: {
  id: string;
  kinds: readonly ApiJobKind[];
  fallback: () => Promise<OperationalJobAccess | null>;
}): Promise<OperationalJobAccess | null> {
  let access: ApiJobAccess | null = null;
  try {
    access = await readApiJobAccess(params.id);
  } catch (error) {
    logger.warn("Bigtable job access read failed; using legacy lookup", {
      error,
      jobId: params.id,
    });
  }

  if (access) {
    return params.kinds.includes(access.kind) ? access : null;
  }

  const fallback = await params.fallback();
  return fallback && Number.isFinite(fallback.expiresAtMs) ? fallback : null;
}

export function getScrapeJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({
    id,
    kinds: ["scrape"],
    fallback: async () => {
      const row = await supabaseGetScrapeById(id);
      return row
        ? {
            teamId: row.team_id,
            kind: "scrape",
            expiresAtMs: new Date(row.created_at).getTime() + DEFAULT_TTL_MS,
          }
        : null;
    },
  });
}

export function getExtractJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({
    id,
    kinds: ["extract", "agent"],
    fallback: async () => {
      const row = await supabaseGetExtractRequestByIdDirect(id);
      if (!row || (row.kind !== "extract" && row.kind !== "agent")) return null;
      return {
        teamId: row.team_id,
        kind: row.kind,
        clientOrigin: row.origin ?? undefined,
        expiresAtMs: new Date(row.created_at).getTime() + DEFAULT_TTL_MS,
      };
    },
  });
}

export function getAgentJobAccess(
  id: string,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({
    id,
    kinds: ["agent"],
    fallback: async () => {
      const row = await supabaseGetAgentRequestByIdDirect(id);
      if (!row) return null;
      return {
        teamId: row.team_id,
        kind: "agent",
        clientOrigin: row.origin ?? undefined,
        expiresAtMs: new Date(row.created_at).getTime() + DEFAULT_TTL_MS,
      };
    },
  });
}

export function getCrawlJobAccess(
  id: string,
  ttlHours: number,
): Promise<OperationalJobAccess | null> {
  return resolveOperationalJobAccess({
    id,
    kinds: ["crawl", "batch_scrape"],
    fallback: async () => {
      const row = await supabaseGetCrawlRequestById(id);
      if (!row || (row.kind !== "crawl" && row.kind !== "batch_scrape")) {
        return null;
      }
      return {
        teamId: row.team_id,
        kind: row.kind,
        expiresAtMs:
          new Date(row.created_at!).getTime() + ttlHours * 60 * 60 * 1000,
      };
    },
  });
}
