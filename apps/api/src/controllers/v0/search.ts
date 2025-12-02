import { Request, Response } from "express";
import {
  billTeam,
  checkTeamCredits,
} from "../../services/billing/credit_billing";
import { authenticateUser } from "../auth";
import { RateLimiterMode, ScrapeJobSingleUrls } from "../../types";
import { logJob } from "../../services/logging/log_job";
import { PageOptions, SearchOptions } from "../../lib/entities";
import { search } from "../../search";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../lib/logger";
import { redisEvictConnection } from "../../../src/services/redis";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import * as Sentry from "@sentry/node";
import { getJobPriority } from "../../lib/job-priority";
import {
  fromLegacyScrapeOptions,
  TeamFlags,
  toLegacyDocument,
} from "../v1/types";
import { fromV0Combo } from "../v2/types";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq";
import { defaultOrigin } from "../../lib/default-values";

async function searchHelper(
  jobId: string,
  req: Request,
  team_id: string,
  subscription_id: string | null | undefined,
  crawlerOptions: any,
  pageOptions: PageOptions,
  searchOptions: SearchOptions,
  flags: TeamFlags,
  api_key_id: number | null,
): Promise<{
  success: boolean;
  error?: string;
  data?: any;
  returnCode: number;
}> {
  const query = req.body.query;
  const advanced = false;
  if (!query) {
    return { success: false, error: "Query is required", returnCode: 400 };
  }

  const tbs = searchOptions.tbs ?? undefined;
  const filter = searchOptions.filter ?? undefined;
  let num_results = Math.min(searchOptions.limit ?? 7, 10);

  if (team_id === "d97c4ceb-290b-4957-8432-2b2a02727d95") {
    num_results = 1;
  }

  const num_results_buffer = Math.floor(num_results * 1.5);

  let res = await search({
    query,
    logger,
    advanced,
    num_results: num_results_buffer,
    tbs,
    filter,
    lang: searchOptions.lang ?? "en",
    country: searchOptions.country ?? "us",
    location: searchOptions.location,
  });

  let justSearch = pageOptions.fetchPageContent === false;

  const { scrapeOptions, internalOptions } = fromV0Combo(
    pageOptions,
    undefined,
    60000,
    crawlerOptions,
    team_id,
  );

  if (justSearch) {
    billTeam(team_id, subscription_id, res.length, api_key_id, logger).catch(
      error => {
        logger.error(
          `Failed to bill team ${team_id} for ${res.length} credits: ${error}`,
        );
        // Optionally, you could notify an admin or add to a retry queue here
      },
    );
    return { success: true, data: res, returnCode: 200 };
  }

  res = res.filter(r => !isUrlBlocked(r.url, flags));
  if (res.length > num_results) {
    res = res.slice(0, num_results);
  }

  if (res.length === 0) {
    return { success: true, error: "No search results found", returnCode: 200 };
  }

  const jobPriority = await getJobPriority({ team_id, basePriority: 20 });

  // filter out social media links

  const jobDatas = res.map(x => {
    const url = x.url;
    const uuid = uuidv7();
    return {
      jobId: uuid,
      data: {
        url,
        mode: "single_urls" as const,
        team_id: team_id,
        scrapeOptions,
        internalOptions,
        startTime: Date.now(),
        zeroDataRetention: false, // not supported on v0
        apiKeyId: api_key_id,
        origin: req.body.origin ?? defaultOrigin,
      } satisfies ScrapeJobSingleUrls,
    };
  });

  // TODO: addScrapeJobs
  for (const job of jobDatas) {
    await addScrapeJob(job.data, job.jobId, jobPriority, false, true);
  }

  const docs = (
    await Promise.all(jobDatas.map(x => waitForJob(x.jobId, 60000, false)))
  ).map(x => toLegacyDocument(x, internalOptions));

  if (docs.length === 0) {
    return { success: true, error: "No search results found", returnCode: 200 };
  }

  await scrapeQueue.removeJobs(jobDatas.map(x => x.jobId));

  // make sure doc.content is not empty
  const filteredDocs = docs.filter(
    (doc: any) => doc && doc.content && doc.content.trim().length > 0,
  );

  if (filteredDocs.length === 0) {
    return {
      success: true,
      error: "No page found",
      returnCode: 200,
      data: docs,
    };
  }

  return {
    success: true,
    data: filteredDocs,
    returnCode: 200,
  };
}

export async function searchController(req: Request, res: Response) {
  try {
    // make sure to authenticate user first, Bearer <token>
    const auth = await authenticateUser(req, res, RateLimiterMode.Search);
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
      .sadd("teams_using_v0:" + team_id, "search:" + jobId)
      .catch(error =>
        logger.error("Failed to add team to teams_using_v0 (2)", {
          error,
          team_id,
        }),
      );

    const crawlerOptions = req.body.crawlerOptions ?? {};
    const pageOptions = req.body.pageOptions ?? {
      includeHtml: req.body.pageOptions?.includeHtml ?? false,
      onlyMainContent: req.body.pageOptions?.onlyMainContent ?? false,
      fetchPageContent: req.body.pageOptions?.fetchPageContent ?? true,
      removeTags: req.body.pageOptions?.removeTags ?? [],
      fallback: req.body.pageOptions?.fallback ?? false,
    };
    const origin = req.body.origin ?? "api";

    const searchOptions = req.body.searchOptions ?? { limit: 5 };

    try {
      const { success: creditsCheckSuccess, message: creditsCheckMessage } =
        await checkTeamCredits(chunk, team_id, 1);
      if (!creditsCheckSuccess) {
        return res.status(402).json({ error: "Insufficient credits" });
      }
    } catch (error) {
      Sentry.captureException(error);
      logger.error(error);
      return res.status(500).json({ error: "Internal server error" });
    }
    const startTime = new Date().getTime();
    const result = await searchHelper(
      jobId,
      req,
      team_id,
      chunk?.sub_id,
      crawlerOptions,
      pageOptions,
      searchOptions,
      chunk?.flags ?? null,
      chunk?.api_key_id ?? null,
    );
    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - startTime) / 1000;
    logJob({
      job_id: jobId,
      success: result.success,
      message: result.error,
      num_docs: result.data ? result.data.length : 0,
      docs: result.data,
      time_taken: timeTakenInSeconds,
      team_id: team_id,
      mode: "search",
      url: req.body.query,
      scrapeOptions: fromLegacyScrapeOptions(
        req.body.pageOptions,
        undefined,
        60000,
        team_id,
      ),
      crawlerOptions: crawlerOptions,
      origin,
      integration: req.body.integration,
      zeroDataRetention: false, // not supported
    });
    return res.status(result.returnCode).json(result);
  } catch (error) {
    if (error instanceof ScrapeJobTimeoutError) {
      return res.status(408).json({ error: error.message });
    }

    Sentry.captureException(error);
    logger.error("Unhandled error occurred in search", { error });
    return res.status(500).json({ error: error.message });
  }
}
