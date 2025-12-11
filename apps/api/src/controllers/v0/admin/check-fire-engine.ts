import { logger } from "../../../lib/logger";
import { config } from "../../../config";
import * as Sentry from "@sentry/node";
import { Request, Response } from "express";

export async function checkFireEngine(req: Request, res: Response) {
  try {
    if (!config.FIRE_ENGINE_BETA_URL) {
      logger.warn("Fire engine beta URL not configured");
      return res.status(500).json({
        success: false,
        error: "Fire engine beta URL not configured",
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const urls = ["https://roastmywebsite.ai", "https://example.com"];
    let lastError: any = null;

    for (const url of urls) {
      try {
        const response = await fetch(`${config.FIRE_ENGINE_BETA_URL}/scrape`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Disable-Cache": "true",
          },
          body: JSON.stringify({
            url,
            engine: "chrome-cdp",
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          const responseData = await response.json();
          return res.status(200).json({
            data: responseData,
          });
        }
        lastError = `Fire engine returned status ${response.status}`;
      } catch (error) {
        if (error.name === "AbortError") {
          return res.status(504).json({
            success: false,
            error: "Request timed out after 30 seconds",
          });
        }
        lastError = error;
      }
    }

    // If we get here, all retries failed
    logger.error("An error occurred while checking fire-engine", {
      module: "admin",
      method: "checkFireEngine",
      error: lastError,
    });
    Sentry.captureException(lastError);
    return res.status(500).json({
      success: false,
      error: "Internal server error - all retry attempts failed",
    });
  } catch (error) {
    logger.error(error);
    Sentry.captureException(error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
}
