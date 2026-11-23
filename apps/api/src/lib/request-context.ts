/*
 * Builds the context a request runs under, and reads it back from the two
 * stored shapes that carry it: a scrape job's payload and a crawl record.
 *
 * No other file builds a RequestContext. The code that accepts a request, or
 * that starts work of the service's own, calls `requestContext` once, with
 * the facts it has resolved, and everything after that copies the value.
 */
import type { TeamFlags } from "../controllers/v2/types";
import type { RequestContext } from "../service/request-context";
import type { BillingMetadata } from "../services/billing/types";
import type { ScrapeJobData } from "../types";
import type { StoredCrawl } from "./crawl-redis";

declare module "../service/request-context" {
  interface RequestContext {
    /**
     * The team's flags when the context was built: `null` when the team has
     * none, absent when they were not looked up.
     */
    flags?: TeamFlags;
    /**
     * The organization the work runs under, `null` when it runs under none.
     * It is not always the organization the team belongs to.
     */
    orgId?: string | null;
    /** The API key the request was made with, `null` when it had none. */
    apiKeyId?: number | null;
    /** How the work of the request is billed. */
    billing?: BillingMetadata;
  }
}

export function requestContext(facts: {
  teamId: string;
  zeroDataRetention: boolean | undefined;
  flags?: TeamFlags;
  orgId?: string | null;
  apiKeyId?: number | null;
  billing?: BillingMetadata;
}): RequestContext {
  return {
    teamId: facts.teamId,
    zeroDataRetention: facts.zeroDataRetention ?? false,
    flags: facts.flags,
    orgId: facts.orgId,
    apiKeyId: facts.apiKeyId,
    billing: facts.billing,
  };
}

/**
 * The context a scrape job runs under. A payload written before the context
 * existed has none, so the same facts are taken from the fields that have
 * always carried them.
 */
export function jobContext(data: ScrapeJobData): RequestContext {
  const options =
    data.mode === "kickoff_sitemap" ? undefined : data.internalOptions;
  return (
    data.ctx ??
    requestContext({
      teamId: data.team_id,
      zeroDataRetention: data.zeroDataRetention,
      flags: options?.teamFlags,
      orgId: options?.orgId,
      apiKeyId: data.apiKeyId,
      billing: data.billing,
    })
  );
}

/**
 * Whether a stored payload or crawl record is under zero data retention,
 * `undefined` when it does not say. For code that carries the payloads of
 * every queue, or that may be handed a job whose data is gone.
 */
export function storedZeroDataRetention(stored: unknown): boolean | undefined {
  const shape = stored as
    | { ctx?: RequestContext; zeroDataRetention?: boolean }
    | null
    | undefined;
  return shape?.ctx?.zeroDataRetention ?? shape?.zeroDataRetention;
}

/** The context a crawl runs under, with the same fallback as `jobContext`. */
export function crawlContext(crawl: StoredCrawl): RequestContext {
  return (
    crawl.ctx ??
    requestContext({
      teamId: crawl.team_id,
      zeroDataRetention: crawl.zeroDataRetention,
      flags: crawl.internalOptions?.teamFlags,
      orgId: crawl.internalOptions?.orgId,
    })
  );
}
