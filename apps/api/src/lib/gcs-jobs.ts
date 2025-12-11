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

const credentials = config.GCS_CREDENTIALS
  ? JSON.parse(atob(config.GCS_CREDENTIALS))
  : undefined;
export const storage = new Storage({ credentials });

export async function saveScrapeToGCS(scrape: LoggedScrape): Promise<void> {
  return await withSpan("firecrawl-gcs-save-job", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "save_job",
      "job.id": scrape.id,
      "job.team_id": scrape.team_id,
      "job.mode": "scrape",
      "job.success": scrape.is_successful,
      "job.num_docs": 1,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${scrape.id}.json`);

    // Save job docs with retry
    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify([scrape.doc]), {
          contentType: "application/json",
        });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving job to GCS, retrying`, {
            error,
            scrapeId: scrape.id,
            jobId: scrape.id,
            i,
            zeroDataRetention: scrape.zeroDataRetention,
          });
        }
      }
    }

    // Save job metadata with retry
    for (let i = 0; i < 3; i++) {
      try {
        await blob.setMetadata({
          metadata: {
            job_id: scrape.id ?? null,
            success: scrape.is_successful,
            message: scrape.zeroDataRetention ? null : (scrape.error ?? null),
            num_docs: 1,
            time_taken: scrape.time_taken,
            team_id:
              scrape.team_id === "preview" ||
              scrape.team_id?.startsWith("preview_")
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
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving scrape metadata to GCS, retrying`, {
            error,
            scrapeId: scrape.id,
            jobId: scrape.id,
            i,
            zeroDataRetention: scrape.zeroDataRetention,
          });
        }
      }
    }

    setSpanAttributes(span, { "gcs.save_successful": true });
  }).catch(error => {
    logger.error(`Error saving scrape to GCS`, {
      error,
      scrapeId: scrape.id,
      jobId: scrape.id,
      zeroDataRetention: scrape.zeroDataRetention,
    });
    throw error;
  });
}

export async function saveSearchToGCS(search: LoggedSearch): Promise<void> {
  return await withSpan("firecrawl-gcs-save-search", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "save_search",
      "search.id": search.id,
      "search.team_id": search.team_id,
      request_id: search.request_id,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${search.id}.json`);

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify(search.results), {
          contentType: "application/json",
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving search to GCS, retrying`, {
            error,
            searchId: search.id,
            i,
          });
        }
      }
    }

    for (let i = 0; i < 3; i++) {
      try {
        await blob.setMetadata({
          metadata: {
            mode: "search",
            job_id: search.id,
            num_docs: search.num_results,
            time_taken: search.time_taken,
            team_id:
              search.team_id === "preview" ||
              search.team_id?.startsWith("preview_")
                ? null
                : search.team_id,
            query: search.zeroDataRetention
              ? "<redacted due to zero data retention>"
              : search.query,
            options: search.zeroDataRetention
              ? null
              : JSON.stringify(search.options),
            credits_cost: search.credits_cost,
            success: search.is_successful,
            error: search.zeroDataRetention ? null : (search.error ?? null),
            num_results: search.num_results,
          },
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving search metadata to GCS, retrying`, {
            error,
            searchId: search.id,
            i,
          });
        }
      }
    }
  });
}

export async function saveExtractToGCS(extract: LoggedExtract): Promise<void> {
  return await withSpan("firecrawl-gcs-save-extract", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "save_extract",
      "extract.id": extract.id,
      "extract.team_id": extract.team_id,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${extract.id}.json`);

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify(extract.result), {
          contentType: "application/json",
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving extract to GCS, retrying`, {
            error,
            extractId: extract.id,
            i,
          });
        }
      }
    }

    for (let i = 0; i < 3; i++) {
      try {
        await blob.setMetadata({
          metadata: {
            mode: "extract",
            job_id: extract.id,
            num_docs: 1,
            team_id:
              extract.team_id === "preview" ||
              extract.team_id?.startsWith("preview_")
                ? null
                : extract.team_id,
            options: JSON.stringify(extract.options),
            credits_cost: extract.credits_cost,
            success: extract.is_successful,
            error: extract.error ?? null,
          },
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving extract metadata to GCS, retrying`, {
            error,
            extractId: extract.id,
            i,
          });
        }
      }
    }

    setSpanAttributes(span, { "gcs.save_successful": true });
    return;
  });
}

export async function saveMapToGCS(map: LoggedMap): Promise<void> {
  return await withSpan("firecrawl-gcs-save-map", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "save_map",
      "map.id": map.id,
      "map.team_id": map.team_id,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${map.id}.json`);

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify(map.results), {
          contentType: "application/json",
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving map to GCS, retrying`, {
            error,
            mapId: map.id,
            i,
          });
        }
      }
    }

    for (let i = 0; i < 3; i++) {
      try {
        await blob.setMetadata({
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
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving map metadata to GCS, retrying`, {
            error,
            mapId: map.id,
            i,
          });
        }
      }
    }

    setSpanAttributes(span, { "gcs.save_successful": true });
    return;
  });
}

export async function saveDeepResearchToGCS(
  deepResearch: LoggedDeepResearch,
): Promise<void> {
  return await withSpan("firecrawl-gcs-save-deep-research", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "save_deep_research",
      "deep_research.id": deepResearch.id,
      "deep_research.team_id": deepResearch.team_id,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${deepResearch.id}.json`);

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify(deepResearch.result), {
          contentType: "application/json",
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving deep research to GCS, retrying`, {
            error,
            deepResearchId: deepResearch.id,
            i,
          });
        }
      }
    }

    for (let i = 0; i < 3; i++) {
      try {
        await blob.setMetadata({
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
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving deep research metadata to GCS, retrying`, {
            error,
            deepResearchId: deepResearch.id,
            i,
          });
        }
      }
    }

    setSpanAttributes(span, { "gcs.save_successful": true });
    return;
  });
}

export async function saveLlmsTxtToGCS(llmsTxt: LoggedLlmsTxt): Promise<void> {
  return await withSpan("firecrawl-gcs-save-llms-txt", async span => {
    setSpanAttributes(span, {
      "gcs.operation": "save_llms_txt",
      "llms_txt.id": llmsTxt.id,
      "llms_txt.team_id": llmsTxt.team_id,
    });

    if (!config.GCS_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${llmsTxt.id}.json`);

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify(llmsTxt.result), {
          contentType: "application/json",
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving llms txt to GCS, retrying`, {
            error,
            llmsTxtId: llmsTxt.id,
            i,
          });
        }
      }
    }

    for (let i = 0; i < 3; i++) {
      try {
        await blob.setMetadata({
          metadata: {
            mode: "llms_txt",
            job_id: llmsTxt.id,
            team_id:
              llmsTxt.team_id === "preview" ||
              llmsTxt.team_id?.startsWith("preview_")
                ? null
                : llmsTxt.team_id,
            options: JSON.stringify(llmsTxt.options),
            credits_cost: llmsTxt.credits_cost,
            success: true,
            num_urls: llmsTxt.num_urls,
            cost_tracking: JSON.stringify(llmsTxt.cost_tracking),
          },
        });
        setSpanAttributes(span, { "gcs.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving llms txt metadata to GCS, retrying`, {
            error,
            llmsTxtId: llmsTxt.id,
            i,
          });
        }
      }
    }

    setSpanAttributes(span, { "gcs.save_successful": true });
    return;
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
    const blob = bucket.file(`${jobId}.json`);

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

export async function removeJobFromGCS(jobId: string): Promise<void> {
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
    const blob = bucket.file(`${jobId}.json`);

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

      logger.error(`Error removing job from GCS`, {
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
  //   logger.info(`Getting f-engine document from GCS`, {
  //     url,
  //   });
  try {
    if (!config.GCS_FIRE_ENGINE_BUCKET_NAME) {
      return null;
    }

    const bucket = storage.bucket(config.GCS_FIRE_ENGINE_BUCKET_NAME);
    const blob = bucket.file(`${url}`);
    const [exists] = await blob.exists();
    if (!exists) {
      return null;
    }
    const [blobContent] = await blob.download();
    const parsed = JSON.parse(blobContent.toString());
    return parsed;
  } catch (error) {
    logger.error(`Error getting f-engine document from GCS`, {
      error,
      url,
    });
    return null;
  }
}
