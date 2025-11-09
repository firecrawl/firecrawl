import { ScrapeJobSingleUrls, RunWebScraperParams } from "../types";
import { logger as _logger } from "../lib/logger";
import { configDotenv } from "dotenv";
import { scrapeURL, ScrapeUrlResponse } from "../scraper/scrapeURL";
import type { NuQJob } from "../services/worker/nuq";
import { CostTracking } from "../lib/cost-tracking";
import { AbortInstance } from "../scraper/scrapeURL/lib/abortManager";
configDotenv();

export async function startWebScraperPipeline({
  job,
  costTracking,
  cancellationAbort,
}: {
  job: NuQJob<ScrapeJobSingleUrls>;
  costTracking: CostTracking;
  cancellationAbort?: AbortInstance;
}) {
  return await runWebScraper({
    url: job.data.url,
    scrapeOptions: {
      ...job.data.scrapeOptions,
      ...(job.data.crawl_id
        ? {
            formats: job.data.scrapeOptions.formats.concat([
              { type: "rawHtml" },
            ]),
          }
        : {}),
    },
    internalOptions: {
      crawlId: job.data.crawl_id,
      teamId: job.data.team_id,
      ...job.data.internalOptions,
      externalAbort:
        cancellationAbort ?? job.data.internalOptions?.externalAbort,
    },
    team_id: job.data.team_id,
    bull_job_id: job.id,
    priority: job.priority,
    is_crawl: !!(job.data.crawl_id && job.data.crawlerOptions !== null),
    urlInvisibleInCurrentCrawl:
      job.data.crawlerOptions?.urlInvisibleInCurrentCrawl ?? false,
    costTracking,
  });
}

async function runWebScraper({
  url,
  scrapeOptions,
  internalOptions,
  team_id,
  bull_job_id,
  priority,
  is_crawl = false,
  urlInvisibleInCurrentCrawl = false,
  costTracking,
}: RunWebScraperParams): Promise<ScrapeUrlResponse> {
  const logger = _logger.child({
    method: "runWebScraper",
    module: "runWebscraper",
    scrapeId: bull_job_id,
    jobId: bull_job_id,
    zeroDataRetention: internalOptions?.zeroDataRetention,
  });
  const tries = is_crawl ? 3 : 1;

  logger.info("runWebScraper called");

  let response: ScrapeUrlResponse | undefined = undefined;
  let error: any = undefined;

  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      logger.debug("Retrying scrape...", {
        tries,
        i,
        previousStatusCode: (response as any)?.document?.metadata?.statusCode,
        previousError: error,
      });
    }

    response = undefined;
    error = undefined;

    try {
      logger.info("running scrapeURL...");
      response = await scrapeURL(
        bull_job_id,
        url,
        scrapeOptions,
        {
          priority,
          ...internalOptions,
          urlInvisibleInCurrentCrawl,
          teamId: internalOptions?.teamId ?? team_id,
        },
        costTracking,
      );
      if (!response.success) {
        if (response.error instanceof Error) {
          throw response.error;
        } else {
          throw new Error(
            "scrapeURL error: " +
              (Array.isArray(response.error)
                ? JSON.stringify(response.error)
                : typeof response.error === "object"
                  ? JSON.stringify({ ...response.error })
                  : response.error),
          );
        }
      }

      if (
        (response.document.metadata.statusCode >= 200 &&
          response.document.metadata.statusCode < 300) ||
        response.document.metadata.statusCode === 304
      ) {
        // status code is good -- do not attempt retry
        break;
      }
    } catch (_error) {
      error = _error;
    }
  }

  // const engineOrder = Object.entries(engines)
  //   .sort((a, b) => a[1].startedAt - b[1].startedAt)
  //   .map((x) => x[0]) as Engine[];

  // for (const engine of engineOrder) {
  //   const result = engines[engine] as Exclude<
  //     EngineResultsTracker[Engine],
  //     undefined
  //   >;
  //   ScrapeEvents.insert(bull_job_id, {
  //     type: "scrape",
  //     url,
  //     method: engine,
  //     result: {
  //       success: result.state === "success",
  //       response_code:
  //         result.state === "success" ? result.result.statusCode : undefined,
  //       response_size:
  //         result.state === "success" ? result.result.html.length : undefined,
  //       error:
  //         result.state === "error"
  //           ? result.error
  //           : result.state === "timeout"
  //             ? "Timed out"
  //             : undefined,
  //       time_taken: result.finishedAt - result.startedAt,
  //     },
  //   });
  // }

  if (error === undefined && response?.success) {
    return response;
  } else {
    if (response !== undefined) {
      return {
        ...response,
        success: false,
        error,
      };
    } else {
      return {
        success: false,
        error,
      };
    }
  }
}
