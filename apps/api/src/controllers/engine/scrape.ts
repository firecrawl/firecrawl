import { Request, Response } from "express";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../lib/logger";
import { redisConnection } from "../../services/redis";
import { processJobInternal } from "../../services/worker/scrape-worker";
import { ScrapeJobData } from "../../types";
import { getJobPriority } from "../../lib/job-priority";
import { fromV1ScrapeOptions } from "../v2/types";
import { teamConcurrencySemaphore } from "../../services/worker/team-semaphore";
import { checkPermissions } from "../../lib/permissions";
import { includesFormat } from "../../lib/format-utils";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { logRequest } from "../../services/logging/log_job";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import { TransportableError } from "../../lib/error";
import { AbortManagerThrownError } from "../../scraper/scrapeURL/lib/abortManager";
import { getErrorContactMessage } from "../../lib/deployment";

// Import the schemas from fire-engine
const successSchema = z.object({
  jobId: z.string().optional(),
  timeTaken: z.number(),
  content: z.string(),
  url: z.string().optional(),
  pageStatusCode: z.number(),
  pageError: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  screenshots: z.string().array().optional(),
  actionContent: z
    .object({
      url: z.string(),
      html: z.string(),
    })
    .array()
    .optional(),
  actionResults: z
    .union([
      z.object({
        idx: z.number(),
        type: z.literal("screenshot"),
        result: z.object({
          path: z.string(),
        }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("scrape"),
        result: z.union([
          z.object({
            url: z.string(),
            html: z.string(),
          }),
          z.object({
            url: z.string(),
            accessibility: z.string(),
          }),
        ]),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("executeJavascript"),
        result: z.object({
          return: z.string(),
        }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("pdf"),
        result: z.object({
          link: z.string(),
        }),
      }),
    ])
    .array()
    .optional(),
  file: z
    .object({
      name: z.string(),
      content: z.string(),
    })
    .optional()
    .or(z.null()),
  docUrl: z.string().optional(),
  usedMobileProxy: z.boolean().optional(),
  youtubeTranscriptContent: z.any().optional(),
  timezone: z.string().optional(),
});

const processingSchema = z.object({
  jobId: z.string(),
  processing: z.boolean(),
});

const failedSchema = z.object({
  error: z.string(),
  retryWithStealth: z.boolean().optional(),
});

// For status endpoint
const statusSuccessSchema = z.object({
  jobId: z.string(),
  state: z.literal("completed"),
  processing: z.literal(false),
  content: z.string(),
  url: z.string().optional(),
  pageStatusCode: z.number(),
  pageError: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  screenshots: z.string().array().optional(),
  actionContent: z
    .object({
      url: z.string(),
      html: z.string(),
    })
    .array()
    .optional(),
  actionResults: z
    .union([
      z.object({
        idx: z.number(),
        type: z.literal("screenshot"),
        result: z.object({
          path: z.string(),
        }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("scrape"),
        result: z.union([
          z.object({
            url: z.string(),
            html: z.string(),
          }),
          z.object({
            url: z.string(),
            accessibility: z.string(),
          }),
        ]),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("executeJavascript"),
        result: z.object({
          return: z.string(),
        }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("pdf"),
        result: z.object({
          link: z.string(),
        }),
      }),
    ])
    .array()
    .optional(),
  file: z
    .object({
      name: z.string(),
      content: z.string(),
    })
    .optional()
    .or(z.null()),
  docUrl: z.string().optional(),
  usedMobileProxy: z.boolean().optional(),
  youtubeTranscriptContent: z.any().optional(),
  timezone: z.string().optional(),
});

const statusProcessingSchema = z.object({
  jobId: z.string(),
  state: z.enum([
    "delayed",
    "active",
    "waiting",
    "waiting-children",
    "unknown",
    "prioritized",
    "pending",
  ]),
  processing: z.boolean(),
});

const statusFailedSchema = z.object({
  jobId: z.string(),
  state: z.literal("failed"),
  processing: z.literal(false),
  error: z.string(),
  retryWithStealth: z.boolean().optional(),
});

// Redis key prefix
const JOB_PREFIX = "fire-engine-job:";

// Types for Fire Engine request
type FireEngineScrapeRequest = {
  url: string;
  scrapeId?: string;
  headers?: { [K: string]: string };
  blockMedia?: boolean;
  pageOptions?: any;
  useProxy?: boolean;
  customProxy?: string;
  disableSmartWaitCache?: boolean;
  skipDnsCheck?: boolean;
  priority?: number;
  team_id?: string;
  logRequest?: boolean;
  instantReturn?: boolean;
  geolocation?: { country?: string; languages?: string[] };
  mobileProxy?: boolean;
  timeout?: number;
  saveScrapeResultToGCS?: boolean;
  zeroDataRetention?: boolean;
  engine?: "chrome-cdp" | "tlsclient";
  skipTlsVerification?: boolean;
  actions?: any[];
  mobile?: boolean;
  persistentStorage?: { uniqueId: string };
  atsv?: boolean;
  disableJsDom?: boolean;
};

// Start scrape endpoint
export async function fireEngineScrapeController(
  req: Request<{}, any, FireEngineScrapeRequest>,
  res: Response,
) {
  const jobId = uuidv7();
  const loggerInstance = logger.child({
    method: "fireEngineScrapeController",
    jobId,
  });

  try {
    // For self-hosted, bypass auth or use principal
    // For now, assume unlimited
    const acuc = {
      flags: [],
      api_key_id: null,
      credits: 999999,
      concurrency: 10,
      bypass: true,
    };

    const permissions = checkPermissions(req.body, acuc.flags);
    if (permissions.error) {
      return res.status(403).json({
        success: false,
        error: permissions.error,
      });
    }

    const zeroDataRetention = req.body.zeroDataRetention || false;

    loggerInstance.debug("Fire Engine scrape starting", {
      jobId,
      url: req.body.url,
      instantReturn: req.body.instantReturn,
    });

    const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
      {
        url: req.body.url,
        formats: ["markdown"], // default
        onlyMainContent: true,
        includeTags: [],
        removeTags: [],
        waitFor: 0,
        timeout: req.body.timeout || 30000,
        headers: req.body.headers,
        actions: req.body.actions,
        location: req.body.geolocation,
        skipTlsVerification: req.body.skipTlsVerification,
        mobile: req.body.mobile,
        removeBase64Images: req.body.blockMedia,
        disableJsDom: req.body.disableJsDom,
      },
      req.body.timeout || 30000,
      "self-hosted", // team_id
    );

    const priority = getJobPriority({
      priority: req.body.priority || 1,
      team_id: "self-hosted",
    });

    const jobData: ScrapeJobData = {
      job_id: jobId,
      url: req.body.url,
      mode: "single_urls",
      scrapeOptions,
      internalOptions,
      origin: "fire-engine-compat",
      timeout: req.body.timeout || 30000,
      team_id: "self-hosted",
      priority,
      is_scrape: true,
      zeroDataRetention,
      concurrentRequest: 1,
      total: 1,
    };

    if (req.body.instantReturn === false) {
      // Async: save to Redis and queue
      const redis = redisConnection;
      const key = `${JOB_PREFIX}${jobId}`;
      await redis.setex(key, 3600, JSON.stringify({
        status: "processing",
        createdAt: Date.now(),
      }));

      // Queue the job (need to create a queue for this)
      // For now, process immediately but mark as async
      // TODO: implement proper queue

      // For simplicity, process immediately and update Redis
      const semaphore = teamConcurrencySemaphore("self-hosted");
      const release = await semaphore.acquire();

      try {
        const result = await processJobInternal(jobData, loggerInstance);

        const response = {
          jobId,
          timeTaken: result.timeTaken || 0,
          content: result.content || "",
          url: result.url,
          pageStatusCode: result.pageStatusCode || 200,
          pageError: result.pageError,
          responseHeaders: result.responseHeaders,
          screenshots: result.screenshots,
          actionContent: result.actionContent,
          actionResults: result.actionResults,
          file: result.file,
          docUrl: result.docUrl,
          usedMobileProxy: result.usedMobileProxy,
          youtubeTranscriptContent: result.youtubeTranscriptContent,
          timezone: result.timezone,
        };

        await redis.setex(key, 3600, JSON.stringify({
          status: "completed",
          result: response,
        }));

        return res.json({
          jobId,
          processing: false,
        });
      } catch (error) {
        loggerInstance.error("Scrape job failed", { error, jobId });
        await redis.setex(key, 3600, JSON.stringify({
          status: "failed",
          error: (error as Error).message,
        }));
        return res.status(500).json({
          error: (error as Error).message || "Internal server error",
        });
      } finally {
        release();
      }
    } else {
      // Sync: process immediately
      const semaphore = teamConcurrencySemaphore("self-hosted");
      const release = await semaphore.acquire();

      try {
        const result = await processJobInternal(jobData, loggerInstance);

        const response = {
          jobId,
          timeTaken: result.timeTaken || 0,
          content: result.content || "",
          url: result.url,
          pageStatusCode: result.pageStatusCode || 200,
          pageError: result.pageError,
          responseHeaders: result.responseHeaders,
          screenshots: result.screenshots,
          actionContent: result.actionContent,
          actionResults: result.actionResults,
          file: result.file,
          docUrl: result.docUrl,
          usedMobileProxy: result.usedMobileProxy,
          youtubeTranscriptContent: result.youtubeTranscriptContent,
          timezone: result.timezone,
        };

        const parse = successSchema.safeParse(response);
        if (parse.success) {
          return res.json(parse.data);
        } else {
          return res.json(response);
        }
      } catch (error) {
        if (error instanceof AbortManagerThrownError) {
          return res.status(408).json({
            error: "Request timeout",
          });
        }

        loggerInstance.error("Scrape job failed", { error, jobId });

        captureExceptionWithZdrCheck(error as Error, {
          tags: {
            jobId,
            teamId: "self-hosted",
          },
        });

        return res.status(500).json({
          error: (error as Error).message || "Internal server error",
        });
      } finally {
        release();
      }
    }
  } catch (error) {
    loggerInstance.error("Fire Engine scrape controller error", { error, jobId });
    return res.status(500).json({
      error: "Internal server error",
    });
  }
}

// Status endpoint
export async function fireEngineStatusController(
  req: Request<{ jobId: string }>,
  res: Response,
) {
  const { jobId } = req.params;
  const loggerInstance = logger.child({
    method: "fireEngineStatusController",
    jobId,
  });

  try {
    const redis = redisConnection;
    const key = `${JOB_PREFIX}${jobId}`;
    const data = await redis.get(key);

    if (!data) {
      return res.status(404).json({
        error: "Job not found",
      });
    }

    const jobData = JSON.parse(data);

    if (jobData.status === "processing") {
      return res.json({
        jobId,
        state: "active",
        processing: true,
      });
    } else if (jobData.status === "completed") {
      return res.json({
        jobId,
        state: "completed",
        processing: false,
        ...jobData.result,
      });
    } else if (jobData.status === "failed") {
      return res.json({
        jobId,
        state: "failed",
        processing: false,
        error: jobData.error,
      });
    } else {
      return res.json({
        jobId,
        state: "pending",
        processing: true,
      });
    }
  } catch (error) {
    loggerInstance.error("Fire Engine status controller error", { error, jobId });
    return res.status(500).json({
      error: "Internal server error",
    });
  }
}

// Delete endpoint
export async function fireEngineDeleteController(
  req: Request<{ jobId: string }>,
  res: Response,
) {
  const { jobId } = req.params;
  const loggerInstance = logger.child({
    method: "fireEngineDeleteController",
    jobId,
  });

  try {
    const redis = redisConnection;
    const key = `${JOB_PREFIX}${jobId}`;
    await redis.del(key);

    loggerInstance.debug("Deleted job from Fire Engine", { jobId });
    return res.status(200).json({});
  } catch (error) {
    loggerInstance.error("Fire Engine delete controller error", { error, jobId });
    return res.status(500).json({
      error: "Internal server error",
    });
  }
}