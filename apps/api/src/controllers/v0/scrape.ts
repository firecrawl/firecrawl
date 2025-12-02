import { ExtractorOptions, PageOptions } from "./../../lib/entities";
import { Request, Response } from "express";
import { checkTeamCredits } from "../../services/billing/credit_billing";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../types";
import { TeamFlags, toLegacyDocument, url as urlSchema } from "../v1/types";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist"; // Import the isUrlBlocked function
import {
  defaultPageOptions,
  defaultExtractorOptions,
  defaultTimeout,
  defaultOrigin,
} from "../../lib/default-values";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import { redisEvictConnection } from "../../../src/services/redis";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../lib/logger";
import * as Sentry from "@sentry/node";
import { getJobPriority } from "../../lib/job-priority";
import { ZodError } from "zod";
import { Document as V0Document } from "./../../lib/entities";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
import { fromV0Combo } from "../v2/types";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq";
import { getErrorContactMessage } from "../../lib/deployment";

async function scrapeHelper(
  jobId: string,
  req: Request,
  team_id: string,
  crawlerOptions: any,
  pageOptions: PageOptions,
  extractorOptions: ExtractorOptions,
  timeout: number,
  flags: TeamFlags,
  apiKeyId: number | null,
): Promise<{
  success: boolean;
  error?: string;
  data?: V0Document | { url: string };
  returnCode: number;
}> {
  const url = urlSchema.parse(req.body.url);
  if (typeof url !== "string") {
    return { success: false, error: "Url is required", returnCode: 400 };
  }

  if (isUrlBlocked(url, flags)) {
    return {
      success: false,
      error: BLOCKLISTED_URL_MESSAGE,
      returnCode: 403,
    };
  }

  const { scrapeOptions, internalOptions } = fromV0Combo(
    pageOptions,
    extractorOptions,
    timeout,
    crawlerOptions,
    team_id,
  );

  internalOptions.saveScrapeResultToGCS = process.env
    .GCS_FIRE_ENGINE_BUCKET_NAME
    ? true
    : false;

  await addScrapeJob(
    {
      url,
      mode: "single_urls",
      team_id,
      scrapeOptions,
      internalOptions,
      origin: req.body.origin ?? defaultOrigin,
      integration: req.body.integration,
      startTime: Date.now(),
      zeroDataRetention: false, // not supported on v0
      apiKeyId,
    },
    jobId,
    await getJobPriority({ team_id, basePriority: 10 }),
    false,
    true,
  );

  let doc;

  try {
    doc = await waitForJob(jobId, timeout, false);
  } catch (e) {
    if (e instanceof ScrapeJobTimeoutError) {
      return {
        success: false,
        error: e.message,
        returnCode: 408,
      };
    } else if (
      typeof e === "string" &&
      (e.includes("Error generating completions: ") ||
        e.includes("Invalid schema for function") ||
        e.includes(
          "LLM extraction did not match the extraction schema you provided.",
        ))
    ) {
      return {
        success: false,
        error: e,
        returnCode: 500,
      };
    } else {
      throw e;
    }
  }
  const err = null;

  if (err !== null) {
    return err;
  }

  await scrapeQueue.removeJob(jobId);

  if (!doc) {
    console.error("!!! PANIC DOC IS", doc);
    return {
      success: true,
      error: "No page found",
      returnCode: 200,
      data: doc,
    };
  }

  delete doc.index;
  delete doc.provider;

  // Remove rawHtml if pageOptions.rawHtml is false and extractorOptions.mode is llm-extraction-from-raw-html
  if (
    !pageOptions.includeRawHtml &&
    extractorOptions.mode == "llm-extraction-from-raw-html"
  ) {
    if (doc.rawHtml) {
      delete doc.rawHtml;
    }
  }

  if (!pageOptions.includeHtml) {
    if (doc.html) {
      delete doc.html;
    }
  }

  return {
    success: true,
    data: toLegacyDocument(doc, internalOptions),
    returnCode: 200,
  };
}

export async function scrapeController(req: Request, res: Response) {
  try {
    let earlyReturn = false;
    // make sure to authenticate user first, Bearer <token>
    const auth = await authenticateUser(req, res, RateLimiterMode.Scrape);
    if (!auth.success) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const { team_id, chunk } = auth;

    if (chunk?.flags?.forceZDR) {
      return res.status(400).json({
        error:
          "Your team has zero data retention enabled. This is not supported on the v0 API. Please update your code to use the v1 API.",
      });
    }

    const jobId = uuidv7();

    redisEvictConnection.sadd("teams_using_v0", team_id).catch(error =>
      logger.error("Failed to add team to teams_using_v0", {
        error,
        team_id,
      }),
    );

    redisEvictConnection
      .sadd("teams_using_v0:" + team_id, "scrape:" + jobId)
      .catch(error =>
        logger.error("Failed to add team to teams_using_v0 (2)", {
          error,
          team_id,
        }),
      );

    const crawlerOptions = req.body.crawlerOptions ?? {};
    const pageOptions = { ...defaultPageOptions, ...req.body.pageOptions };
    const extractorOptions = {
      ...defaultExtractorOptions,
      ...req.body.extractorOptions,
    };
    const origin = req.body.origin ?? defaultOrigin;
    let timeout = req.body.timeout ?? defaultTimeout;

    if (extractorOptions.mode.includes("llm-extraction")) {
      if (
        typeof extractorOptions.extractionSchema !== "object" ||
        extractorOptions.extractionSchema === null
      ) {
        return res.status(400).json({
          error:
            "extractorOptions.extractionSchema must be an object if llm-extraction mode is specified",
        });
      }

      pageOptions.onlyMainContent = true;
      timeout = req.body.timeout ?? 90000;
    }

    // checkCredits
    try {
      const { success: creditsCheckSuccess, message: creditsCheckMessage } =
        await checkTeamCredits(chunk, team_id, 1);
      if (!creditsCheckSuccess) {
        earlyReturn = true;
        return res.status(402).json({
          error:
            "Insufficient credits. For more credits, you can upgrade your plan at https://firecrawl.dev/pricing",
        });
      }
    } catch (error) {
      logger.error(error);
      earlyReturn = true;
      return res.status(500).json({
        error: getErrorContactMessage(),
      });
    }

    const result = await scrapeHelper(
      jobId,
      req,
      team_id,
      crawlerOptions,
      pageOptions,
      extractorOptions,
      timeout,
      chunk?.flags ?? null,
      chunk?.api_key_id ?? null,
    );

    let doc = result.data;
    if (!pageOptions || !pageOptions.includeRawHtml) {
      if (doc && (doc as V0Document).rawHtml) {
        delete (doc as V0Document).rawHtml;
      }
    }

    if (pageOptions && pageOptions.includeExtract) {
      if (!pageOptions.includeMarkdown && doc && (doc as V0Document).markdown) {
        delete (doc as V0Document).markdown;
      }
    }

    return res.status(result.returnCode).json(result);
  } catch (error) {
    Sentry.captureException(error);
    logger.error("Scrape error occcurred", { error });
    return res.status(500).json({
      error:
        error instanceof ZodError
          ? "Invalid URL"
          : typeof error === "string"
            ? error
            : (error?.message ?? "Internal Server Error"),
    });
  }
}
