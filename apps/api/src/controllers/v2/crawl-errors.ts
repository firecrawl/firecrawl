import type { Response } from "express";
import { z } from "zod";
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
import { jsonValueSchema } from "../../lib/json-types";
configDotenv();

type CrawlErrorEntry = Extract<
  CrawlErrorsResponse,
  { errors: unknown }
>["errors"][number];
type RequiresAction = NonNullable<CrawlErrorEntry["requiresAction"]>;

const nullishString = z
  .string()
  .nullable()
  .transform(value => value ?? undefined)
  .optional();

const requiresActionSchema = z
  .object({
    type: z.string(),
    terms: nullishString,
    version: nullishString,
    url: nullishString,
  })
  .catchall(jsonValueSchema.optional());

const errorWithRequiresActionSchema = z.object({
  requiresAction: requiresActionSchema,
});

function readRequiresAction(error: unknown): RequiresAction | undefined {
  const parsed = errorWithRequiresActionSchema.safeParse(error);
  return parsed.success ? parsed.data.requiresAction : undefined;
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
