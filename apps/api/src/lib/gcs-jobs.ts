import { ApiError, Storage } from "@google-cloud/storage";
import { logger } from "./logger";
import { Document } from "../controllers/v1/types";
import { withSpan, setSpanAttributes } from "./otel-tracer";
import type {
  LoggedDeepResearch,
  LoggedExtract,
  LoggedLlmsTxt,
  LoggedMap,
  LoggedScrape,
  LoggedSearch,
} from "../services/logging/log_job";
import { config } from "../config";
import crypto from "crypto";
import { Logger } from "winston";

const credentials = config.GCS_CREDENTIALS
  ? JSON.parse(atob(config.GCS_CREDENTIALS))
  : undefined;
export const storage = new Storage({ credentials });

const storageManualRetries = new Storage({
  credentials,
  retryOptions: {
    autoRetry: false,
    maxRetries: 0,
    retryableErrorFn: () => false,
  },
});

const BACKOFF_PARAMS = [0, 250, 1000];
const BACKOFF_SLOWDOWN_PARAMS = [0, 2000, 4000];

type GCSOperationAttempt = {
  error: any;
  timeMs: number;
  backoffMs: number;
};

/**
 * Converts a job ID to a GCS filename.
 *
 * Before the cutover, the filename is always `<id>.json`.
 * However, after we switched to v7 UUIDs, we realized that it's not working well with how GCS
 * partitions GCS buckets, therefore, we need the filename to start with something random-esque
 * to smooth out the distribution of files between the partitions.
 * Therefore, after May 26, 2026, the filename is `<sha256(id)>-<id>.json`
 *
 * @param id Job ID to convert to a filename
 * @returns Filename for the job in GCS
 */
function idToFilename(id: string): string {
  if (
    id.match(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
    )
  ) {
    const timestamp = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    const cutover = Date.UTC(2026, 4, 26, 0, 0, 0, 0); // Cutover at 2026-05-26 00:00:00 UTC
    if (timestamp < cutover) {
      return `${id}.json`;
    } else {
      return `${crypto.createHash("sha256").update(id).digest("hex")}-${id}.json`;
    }
  } else {
    return `${id}.json`;
  }
}

async function saveJobToGCS(params: {
  mode: string;
  id: string;
  request_id: string;
  team_id: string;
  is_successful: boolean;
  num_docs: number;
  data: any;
  zeroDataRetention: boolean;
  metadata: any;
  logger: Logger;
}): Promise<void> {
  const filename = idToFilename(params.id);
  const logger = params.logger.child({
    module: "gcs-jobs",
    method: "saveJobToGCS",
    mode: params.mode,
    filename,
    zeroDataRetention: params.zeroDataRetention,
  });

  const attempts: GCSOperationAttempt[] = [];

  return await withSpan("firecrawl-gcs-save-job", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "save_job",
      "job.id": params.id,
      "job.request_id": params.request_id,
      "job.team_id": params.team_id,
      "job.mode": params.mode,
      "job.success": params.is_successful,
      "job.num_docs": params.num_docs,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storageManualRetries.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(filename);

    let backoffUsed = BACKOFF_PARAMS;

    const data = JSON.stringify(params.data);

    // Save job docs with retry
    // Due to retries and resumable uploads, this is:
    //  if data is smaller than or exactly 3MB: best case 1 request, worst case 3 requests
    //  if data is larger than 3MB: best case 2 requests, worst case 6 requests
    for (let i = 0; i < backoffUsed.length; i++) {
      const backoffMs = backoffUsed[i];
      if (backoffMs > 0) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }

      const saveStart = Date.now();
      try {
        await blob.save(data, {
          metadata: {
            contentType: "application/json",
            metadata: params.metadata,
          },
          resumable: data.length > 3 * 1024 * 1024, // 3MB, 5MB official limit
        });
        attempts.push({
          error: null,
          timeMs: Date.now() - saveStart,
          backoffMs,
        });
        break;
      } catch (error) {
        if (error instanceof ApiError && error.code === 429) {
          // switch to slower backoff parameters for rate limiting errors
          backoffUsed = BACKOFF_SLOWDOWN_PARAMS;
        }

        attempts.push({ error, timeMs: Date.now() - saveStart, backoffMs });

        if (i === BACKOFF_PARAMS.length - 1) {
          setSpanAttributes(span, { "gcs.save_successful": false });
          throw error;
        }
      }
    }

    setSpanAttributes(span, { "gcs.save_successful": true });
  })
    .then(x => {
      if (attempts.length === 0) {
        return x;
      }

      if (attempts.length === 1) {
        logger.debug("Job saved to GCS", {
          canonicalLog: "gcs-jobs/save",
          attempts,
          success: true,
        });
      } else {
        logger.warn("Job saved to GCS with retries", {
          canonicalLog: "gcs-jobs/save",
          attempts,
          success: true,
        });
      }

      return x;
    })
    .catch(error => {
      logger.error(`Job save to GCS failed`, {
        canonicalLog: "gcs-jobs/save",
        attempts,
        success: false,
        error,
      });
      throw error;
    });
}

export async function saveScrapeToGCS(
  scrape: LoggedScrape,
  _logger: Logger = logger,
): Promise<void> {
  return await saveJobToGCS({
    mode: "scrape",
    id: scrape.id,
    team_id: scrape.team_id,
    is_successful: scrape.is_successful,
    request_id: scrape.request_id,
    num_docs: 1,
    data: [scrape.doc],
    zeroDataRetention: scrape.zeroDataRetention,
    logger: _logger,
    metadata: {
      job_id: scrape.id ?? null,
      success: scrape.is_successful,
      message: scrape.zeroDataRetention ? null : (scrape.error ?? null),
      num_docs: 1,
      time_taken: scrape.time_taken,
      team_id:
        scrape.team_id === "preview" || scrape.team_id?.startsWith("preview_")
          ? null
          : scrape.team_id,
      mode: "scrape",
      url: scrape.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : scrape.url,
      page_options: scrape.zeroDataRetention
        ? null
        : JSON.stringify(scrape.options),
      request_id: scrape.request_id ?? null,
    },
  });
}

export async function saveSearchToGCS(
  search: LoggedSearch,
  _logger: Logger = logger,
): Promise<void> {
  return await saveJobToGCS({
    mode: "search",
    id: search.id,
    team_id: search.team_id,
    request_id: search.request_id,
    num_docs: search.num_results,
    data: search.results,
    metadata: {
      mode: "search",
      job_id: search.id,
      num_docs: search.num_results,
      time_taken: search.time_taken,
      team_id:
        search.team_id === "preview" || search.team_id?.startsWith("preview_")
          ? null
          : search.team_id,
      query: search.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : search.query,
      options: search.zeroDataRetention ? null : JSON.stringify(search.options),
      credits_cost: search.credits_cost,
      success: search.is_successful,
      error: search.zeroDataRetention ? null : (search.error ?? null),
      num_results: search.num_results,
    },
    zeroDataRetention: search.zeroDataRetention,
    is_successful: search.is_successful,
    logger: _logger,
  });
}

export async function saveExtractToGCS(
  extract: LoggedExtract,
  _logger: Logger = logger,
): Promise<void> {
  return await saveJobToGCS({
    mode: "extract",
    id: extract.id,
    team_id: extract.team_id,
    request_id: extract.request_id,
    num_docs: 1,
    is_successful: extract.is_successful,
    data: extract.result,
    zeroDataRetention: false, // ZDR not supported on extract
    metadata: {
      mode: "extract",
      job_id: extract.id,
      num_docs: 1,
      team_id:
        extract.team_id === "preview" || extract.team_id?.startsWith("preview_")
          ? null
          : extract.team_id,
      options: JSON.stringify(extract.options),
      credits_cost: extract.credits_cost,
      success: extract.is_successful,
      error: extract.error ?? null,
    },
    logger: _logger,
  });
}

export async function saveMapToGCS(
  map: LoggedMap,
  _logger: Logger = logger,
): Promise<void> {
  return await saveJobToGCS({
    mode: "map",
    id: map.id,
    request_id: map.request_id,
    team_id: map.team_id,
    is_successful: true,
    num_docs: map.results.length,
    data: map.results,
    zeroDataRetention: map.zeroDataRetention,
    metadata: {
      mode: "map",
      job_id: map.id,
      num_results: map.results.length,
      team_id:
        map.team_id === "preview" || map.team_id?.startsWith("preview_")
          ? null
          : map.team_id,
      options: JSON.stringify(map.options),
      credits_cost: map.credits_cost,
      success: true,
    },
    logger: _logger,
  });
}

export async function saveDeepResearchToGCS(
  deepResearch: LoggedDeepResearch,
  _logger: Logger = logger,
): Promise<void> {
  return await saveJobToGCS({
    mode: "deep_research",
    id: deepResearch.id,
    request_id: deepResearch.request_id,
    team_id: deepResearch.team_id,
    is_successful: true,
    num_docs: 1,
    data: deepResearch.result,
    zeroDataRetention: false, // ZDR not supported on deep research
    metadata: {
      mode: "deep_research",
      job_id: deepResearch.id,
      team_id:
        deepResearch.team_id === "preview" ||
        deepResearch.team_id?.startsWith("preview_")
          ? null
          : deepResearch.team_id,
      options: JSON.stringify(deepResearch.options),
      credits_cost: deepResearch.credits_cost,
      success: true,
      time_taken: deepResearch.time_taken,
    },
    logger: _logger,
  });
}

export async function saveLlmsTxtToGCS(
  llmsTxt: LoggedLlmsTxt,
  _logger: Logger = logger,
): Promise<void> {
  return await saveJobToGCS({
    mode: "llms_txt",
    id: llmsTxt.id,
    team_id: llmsTxt.team_id,
    request_id: llmsTxt.request_id,
    num_docs: 1,
    is_successful: true,
    zeroDataRetention: false, // ZDR not supported on llms txt
    data: llmsTxt.result,
    metadata: {
      mode: "llms_txt",
      job_id: llmsTxt.id,
      team_id:
        llmsTxt.team_id === "preview" || llmsTxt.team_id?.startsWith("preview_")
          ? null
          : llmsTxt.team_id,
      options: JSON.stringify(llmsTxt.options),
      credits_cost: llmsTxt.credits_cost,
      success: true,
      num_urls: llmsTxt.num_urls,
      cost_tracking: JSON.stringify(llmsTxt.cost_tracking),
    },
    logger: _logger,
  });
}

export async function getJobFromGCS(jobId: string): Promise<Document[] | null> {
  return await withSpan("firecrawl-gcs-get-job", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "get_job",
      "job.id": jobId,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return null;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(idToFilename(jobId));

    try {
      const [content] = await blob.download();
      const result = JSON.parse(content.toString());
      setSpanAttributes(span, { "gcs.job_found": true });
      return result;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 404 &&
        error.message.includes("No such object:")
      ) {
        setSpanAttributes(span, { "gcs.job_found": false });
        return null;
      }

      logger.error(`Error getting job from GCS`, {
        error,
        jobId,
        scrapeId: jobId,
      });
      throw error;
    }
  });
}

export async function removeJobFromGCS(
  jobId: string,
  _logger: Logger = logger,
): Promise<void> {
  return await withSpan("firecrawl-gcs-remove-job", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "remove_job",
      "job.id": jobId,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(idToFilename(jobId));

    try {
      await blob.delete({
        ignoreNotFound: true,
      });
      setSpanAttributes(span, { "gcs.delete_successful": true });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 404 &&
        error.message.includes("No such object:")
      ) {
        setSpanAttributes(span, { "gcs.job_not_found": true });
        return;
      }

      _logger.error(`Error removing job from GCS`, {
        error,
        jobId,
        scrapeId: jobId,
      });
      throw error;
    }
  });
}

// TODO: fix the any type (we have multiple Document types in the codebase)
export async function getDocFromGCS(url: string): Promise<any | null> {
  try {
    if (!config.GCS_FIRE_ENGINE_BUCKET_NAME) {
      return null;
    }

    const bucket = storage.bucket(config.GCS_FIRE_ENGINE_BUCKET_NAME);
    const blob = bucket.file(`${url}`);
    const [blobContent] = await blob.download();
    const parsed = JSON.parse(blobContent.toString());
    return parsed;
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === 404 &&
      error.message.includes("No such object:")
    ) {
      return null;
    }

    logger.error(`Error getting f-engine document from GCS`, {
      error,
      url,
    });
    return null;
  }
}
