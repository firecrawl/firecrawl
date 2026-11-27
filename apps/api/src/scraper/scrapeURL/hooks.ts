import type { Logger } from "winston";
import type { Document, ScrapeOptions } from "../../controllers/v2/types";
import type { JsonObject } from "../../lib/json-types";
import { requestContext } from "../../lib/request-context";
import type {
  Hooks,
  JobKind,
  ScrapeFinished,
  ScrapeFinishedMetadata,
  ScrapeMeta,
  ScrapeState,
} from "../../service/hooks";
import type { RequestContext } from "../../service/request-context";
import { installedService } from "../../service/service";
import type { Meta } from ".";
import { bindScrapeMeta } from "./metaContext";

export function scrapeHooks(): Hooks | undefined {
  return installedService()?.hooks;
}

export function toScrapeMeta(
  meta: Meta,
  logger: Logger = meta.logger,
): ScrapeMeta {
  const ctx =
    meta.ctx ??
    requestContext({
      teamId: meta.internalOptions?.teamId ?? "",
      zeroDataRetention: meta.internalOptions?.zeroDataRetention,
      flags: meta.internalOptions?.teamFlags,
      orgId: meta.internalOptions?.orgId,
    });
  const state = (meta.state ??= {});
  bindScrapeMeta(state, meta);
  return {
    id: meta.id ?? "",
    url: meta.url,
    ctx,
    options: meta.options,
    state,
    logger,
    abort: meta.abort ? meta.abort.asSignal() : new AbortController().signal,
  };
}

export interface ScrapeFinishedJobInfo {
  jobId: string;
  requestId?: string;
  kind: JobKind;
  ctx: RequestContext;
  url: string;
  options: ScrapeOptions;
  origin?: string;
  crawlId?: string;
  skipNuq?: boolean;
  isParse?: boolean;
  getState: () => ScrapeState | undefined;
}

export interface ScrapeFinishedOutcome {
  document: Document | null;
  error?: unknown;
  charged: number | undefined;
  timeTakenMs: number;
  startedAt?: number;
  completedAt?: number;
  costTracking?: JsonObject;
  metadata?: ScrapeFinishedMetadata;
}

/**
 * Returns a one-shot emitter for `scrape.finished` so a job emits completion
 * at most once.
 */
export function createScrapeFinishedEmitter(job: ScrapeFinishedJobInfo) {
  let emitted = false;
  return async (outcome: ScrapeFinishedOutcome): Promise<void> => {
    if (emitted) {
      return;
    }
    emitted = true;
    const hooks = scrapeHooks();
    if (!hooks?.has("scrape.finished")) {
      return;
    }
    const payload: ScrapeFinished = {
      jobId: job.jobId,
      requestId: job.requestId,
      kind: job.kind,
      ctx: job.ctx,
      url: job.url,
      options: job.options,
      state: job.getState() ?? {},
      document: outcome.document,
      error: outcome.error,
      charged: outcome.charged,
      timeTakenMs: outcome.timeTakenMs,
    };
    if (outcome.startedAt !== undefined) {
      payload.startedAt = outcome.startedAt;
    }
    if (outcome.completedAt !== undefined) {
      payload.completedAt = outcome.completedAt;
    }
    if (job.origin !== undefined) {
      payload.origin = job.origin;
    }
    if (job.crawlId !== undefined) {
      payload.crawlId = job.crawlId;
    }
    if (job.skipNuq !== undefined) {
      payload.skipNuq = job.skipNuq;
    }
    if (job.isParse !== undefined) {
      payload.isParse = job.isParse;
    }
    if (outcome.costTracking !== undefined) {
      payload.costTracking = outcome.costTracking;
    }
    if (outcome.metadata !== undefined) {
      payload.metadata = outcome.metadata;
    }
    await hooks.run("scrape.finished", payload);
  };
}
