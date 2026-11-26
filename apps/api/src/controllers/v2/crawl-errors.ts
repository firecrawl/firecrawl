import type { Response } from "express";
import type {
  CrawlErrorsResponse,
  CrawlStatusParams,
  RequestWithAuth,
} from "./types";
import { getCrawl, getCrawlRobotsBlocked } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { storedZeroDataRetention } from "../../lib/request-context";
import { logger as _logger } from "../../lib/logger";
import { deserializeTransportableError } from "../../lib/error-serde";
import { scrapeQueue } from "../../services/worker/nuq-router";
import { service } from "../../service";
import type { JobOwner } from "../../service";
import { isJsonObject } from "../../lib/json-types";
configDotenv();

type CrawlErrorEntry = Extract<
  CrawlErrorsResponse,
  { errors: unknown }
>["errors"][number];
type RequiresAction = NonNullable<CrawlErrorEntry["requiresAction"]>;

function isRequiresAction(value: unknown): value is RequiresAction {
  if (!isJsonObject(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.terms !== undefined && typeof value.terms !== "string") {
    return false;
  }
  if (value.version !== undefined && typeof value.version !== "string") {
    return false;
  }
  if (value.url !== undefined && typeof value.url !== "string") {
    return false;
  }
  return true;
}

function readRequiresAction(error: unknown): RequiresAction | undefined {
  if (!isJsonObject(error) || !("requiresAction" in error)) {
    return undefined;
  }
  const value: unknown = error.requiresAction;
  return isRequiresAction(value) ? value : undefined;
}

export async function crawlErrorsController(
  req: RequestWithAuth<CrawlStatusParams, undefined, CrawlErrorsResponse>,
  res: Response<CrawlErrorsResponse>,
) {
  const sc = await getCrawl(req.params.jobId);

  if (sc) {
    if (sc.team_id !== req.auth.team_id) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
  } else {
    const jobKind = (req.path || req.originalUrl || "").includes(
      "/batch/scrape/",
    )
      ? "batchScrape"
      : "crawl";
    let owner: JobOwner | null;
    try {
      owner = await service.modules.jobStore.owner(req.params.jobId, jobKind);
    } catch (requestError: unknown) {
      _logger.error("Error getting request", { error: requestError });
      throw requestError;
    }

    if (
      owner &&
      !(owner.matchesTeam
        ? owner.matchesTeam(req.auth.team_id)
        : owner.teamId === req.auth.team_id)
    ) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    if (
      owner &&
      owner.expiresAtMs !== undefined &&
      owner.expiresAtMs <= Date.now()
    ) {
      return res.status(404).json({ success: false, error: "Job expired" });
    }

    if (!owner) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }
  }

  const logger = _logger.child({
    crawlId: req.params.jobId,
    zeroDataRetention: storedZeroDataRetention(sc) ?? false,
  });
  const failedJobs = (
    await scrapeQueue.getGroupJobs(
      req.params.jobId,
      "failed",
      undefined,
      0,
      logger,
    )
  ).filter(
    (x): x is typeof x & { failedReason: string } =>
      typeof x.failedReason === "string" && x.failedReason.length > 0,
  );

  return res.status(200).json({
    errors: failedJobs.flatMap((x): Array<CrawlErrorEntry> => {
      const error = deserializeTransportableError(x.failedReason);
      if (error?.code === "SCRAPE_RACED_REDIRECT_ERROR") {
        return [];
      }
      const entry: CrawlErrorEntry = {
        id: x.id,
        timestamp:
          x.finishedAt !== undefined
            ? new Date(x.finishedAt).toISOString()
            : undefined,
        url:
          x.data && "url" in x.data
            ? x.data.url
            : "<redacted due to zero data retention>",
        error: error ? error.message : x.failedReason,
      };
      if (error) {
        entry.code = error.code;
        const requiresAction = readRequiresAction(error);
        if (requiresAction !== undefined) {
          entry.requiresAction = requiresAction;
        }
      }
      return [entry];
    }),
    robotsBlocked: await getCrawlRobotsBlocked(req.params.jobId),
  });
}
