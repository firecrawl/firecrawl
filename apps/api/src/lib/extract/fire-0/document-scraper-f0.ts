import { v7 as uuidv7 } from "uuid";
import {
  Document,
  ScrapeOptions,
  TeamFlags,
  URLTrace,
  scrapeOptions as scrapeOptionsSchema,
} from "../../../controllers/v2/types";
import { waitForJob } from "../../../services/queue-jobs";
import { addScrapeJob } from "../../../services/queue-jobs";
import { getJobPriority } from "../../job-priority";
import type { Logger } from "winston";
import { isUrlBlocked } from "../../../scraper/WebScraper/utils/blocklist";
import { scrapeQueue } from "../../../services/worker/nuq";

interface ScrapeDocumentOptions {
  url: string;
  teamId: string;
  origin: string;
  timeout: number;
  isSingleUrl?: boolean;
  flags: TeamFlags | null;
  apiKeyId: number | null;
}

export async function scrapeDocument_F0(
  options: ScrapeDocumentOptions,
  urlTraces: URLTrace[],
  logger: Logger,
  internalScrapeOptions: Partial<ScrapeOptions> = { onlyMainContent: false },
): Promise<Document | null> {
  const trace = urlTraces.find(t => t.url === options.url);
  if (trace) {
    trace.status = "scraped";
    trace.timing.scrapedAt = new Date().toISOString();
  }

  if (isUrlBlocked(options.url, options.flags ?? null)) {
    return null;
  }

  async function attemptScrape(timeout: number) {
    const jobId = uuidv7();
    const jobPriority = await getJobPriority({
      team_id: options.teamId,
      basePriority: 10,
      from_extract: true,
    });

    const scrapeOptions = scrapeOptionsSchema.parse({
      ...internalScrapeOptions,
      maxAge: 4 * 60 * 60 * 1000,
    });

    await addScrapeJob(
      {
        url: options.url,
        mode: "single_urls",
        team_id: options.teamId,
        scrapeOptions,
        internalOptions: {
          teamId: options.teamId,
          bypassBilling: true,
        },
        origin: options.origin,
        is_scrape: true,
        from_extract: true,
        startTime: Date.now(),
        zeroDataRetention: false, // not supported
        apiKeyId: options.apiKeyId,
      },
      jobId,
      jobPriority,
      false,
      true,
    );

    const doc = await waitForJob(jobId, timeout, false, logger);
    try {
      await scrapeQueue.removeJob(jobId, logger);
    } catch (error) {
      logger.warn("Error removing job from queue", { error, scrapeId: jobId });
    }

    if (trace) {
      trace.timing.completedAt = new Date().toISOString();
      trace.contentStats = {
        rawContentLength: doc.markdown?.length || 0,
        processedContentLength: doc.markdown?.length || 0,
        tokensUsed: 0,
      };
    }

    return doc;
  }

  try {
    try {
      logger.debug("Attempting scrape...");
      const x = await attemptScrape(options.timeout);
      logger.debug("Scrape finished!");
      return x;
    } catch (timeoutError) {
      logger.warn("Scrape failed.", { error: timeoutError });

      if (options.isSingleUrl) {
        // For single URLs, try again with double timeout
        logger.debug("Attempting scrape...");
        const x = await attemptScrape(options.timeout * 2);
        logger.debug("Scrape finished!");
        return x;
      }

      throw timeoutError;
    }
  } catch (error) {
    logger.error(`error in scrapeDocument`, { error });
    if (trace) {
      trace.status = "error";
      trace.error = error.message;
    }
    return null;
  }
}
