import { Request, Response } from "express";
import { logger } from "../../../lib/logger";
import { getACUC } from "../../auth";
import { parseApi } from "../../../lib/parseApi";
import { processJobInternal } from "../../../services/worker/scrape-worker";
import { ScrapeJobData } from "../../../types";
import { v7 as uuidv7 } from "uuid";
import { NuQJob } from "../../../services/worker/nuq";
import { fromV1ScrapeOptions } from "../../v2/types";

export async function checkChangeTrackingController(
  req: Request,
  res: Response,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Authorization header required",
    });
  }

  const apiKey = authHeader.slice(7);

  try {
    // Authenticate
    const normalizedApi = parseApi(apiKey);
    const acuc = await getACUC(normalizedApi);

    if (!acuc) {
      return res.status(401).json({
        success: false,
        error: "Invalid API key",
      });
    }

    const jobId = uuidv7();
    const testUrl = req.body.url || "https://example.com";

    logger.info("Change tracking health check starting", {
      jobId,
      teamId: acuc.team_id,
      testUrl,
    });

    const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
      {
        formats: ["markdown", "changeTracking"],
      } as any,
      30000,
      acuc.team_id,
    );

    const job: NuQJob<ScrapeJobData> = {
      id: jobId,
      status: "active",
      createdAt: new Date(),
      priority: 10,
      data: {
        url: testUrl,
        mode: "single_urls",
        team_id: acuc.team_id,
        scrapeOptions,
        internalOptions: {
          ...internalOptions,
          saveScrapeResultToGCS: false,
          bypassBilling: true,
        },
        skipNuq: true,
        origin: "health-check",
        startTime: Date.now(),
        zeroDataRetention: false,
        apiKeyId: acuc.api_key_id ?? null,
        concurrencyLimited: false,
      },
    };

    const doc = await processJobInternal(job);

    if (!doc) {
      return res.status(500).json({
        success: false,
        error: "Scrape returned no document",
      });
    }

    const hasChangeTracking = !!doc.changeTracking;

    logger.info("Change tracking health check completed", {
      jobId,
      teamId: acuc.team_id,
      hasChangeTracking,
      changeStatus: doc.changeTracking?.changeStatus,
    });

    return res.status(200).json({
      success: true,
      data: {
        changeTracking: doc.changeTracking,
        warning: doc.warning,
      },
    });
  } catch (error: any) {
    logger.error("Change tracking health check failed", { error });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
