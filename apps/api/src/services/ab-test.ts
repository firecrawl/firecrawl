import { ScrapeJobData } from "../types";
import { logger as _logger } from "../lib/logger";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";
import { config } from "../config";
import {
  FireEngineScrapeRequestChromeCDP,
  FireEngineScrapeRequestCommon,
  FireEngineScrapeRequestPlaywright,
  FireEngineScrapeRequestTLSClient,
} from "../scraper/scrapeURL/engines/fire-engine/scrape";
import { getDocFromGCS } from "../lib/gcs-jobs";
import { MirrorResult, FireEngineResponse } from "./ab-test-comparison";

export function abTestJob(webScraperOptions: ScrapeJobData) {
  const abLogger = _logger.child({ method: "ABTestToStaging" });
  try {
    const abRate = config.SCRAPEURL_AB_RATE
      ? Math.max(0, Math.min(1, Number(config.SCRAPEURL_AB_RATE)))
      : 0;

    const shouldABTest =
      webScraperOptions.mode === "single_urls" &&
      !webScraperOptions.zeroDataRetention &&
      !webScraperOptions.internalOptions?.zeroDataRetention &&
      abRate > 0 &&
      Math.random() <= abRate &&
      config.SCRAPEURL_AB_HOST &&
      webScraperOptions.internalOptions?.v1Agent === undefined &&
      webScraperOptions.internalOptions?.v1JSONAgent === undefined;

    if (shouldABTest) {
      const timeout = Math.min(
        60000,
        (webScraperOptions.scrapeOptions.timeout ?? 30000) + 10000,
      );

      (async () => {
        const abortController = new AbortController();
        const timeoutHandle = setTimeout(
          () => abortController.abort(),
          timeout,
        );

        try {
          abLogger.info("A/B-testing scrapeURL to staging");
          await robustFetch({
            url: `http://${config.SCRAPEURL_AB_HOST}/v2/scrape`,
            method: "POST",
            body: {
              url: webScraperOptions.url,
              ...webScraperOptions.scrapeOptions,
              origin: (webScraperOptions.scrapeOptions as any).origin ?? "api",
              ...(config.SCRAPEURL_AB_EXTEND_MAXAGE
                ? { maxAge: 900000000 }
                : {}),
            },
            logger: abLogger,
            tryCount: 1,
            ignoreResponse: true,
            mock: null,
            abort: abortController.signal,
          });
          abLogger.info("A/B-testing scrapeURL (staging) request sent");
        } catch (error) {
          abLogger.warn("A/B-testing scrapeURL (staging) failed", { error });
        } finally {
          clearTimeout(timeoutHandle);
        }
      })();
    }
  } catch (error) {
    abLogger.warn("Failed to initiate A/B test to staging", { error });
  }
}

type ABTestDecision =
  | { mode: "none" }
  | { mode: "mirror"; mirrorPromise: Promise<MirrorResult> }
  | { mode: "split"; baseUrl: string };

export function abTestFireEngine(
  feRequest: FireEngineScrapeRequestCommon &
    (
      | FireEngineScrapeRequestChromeCDP
      | FireEngineScrapeRequestPlaywright
      | FireEngineScrapeRequestTLSClient
    ),
): ABTestDecision {
  const abLogger = _logger.child({ method: "ABTestFireEngine" });

  const abRate = config.FIRE_ENGINE_AB_RATE
    ? Math.max(0, Math.min(1, Number(config.FIRE_ENGINE_AB_RATE)))
    : 0;

  const shouldABTest =
    !feRequest.zeroDataRetention &&
    abRate > 0 &&
    Math.random() <= abRate &&
    config.FIRE_ENGINE_AB_URL;

  if (!shouldABTest) {
    return { mode: "none" };
  }

  if (config.FIRE_ENGINE_AB_MODE === "split") {
    return { mode: "split", baseUrl: config.FIRE_ENGINE_AB_URL! };
  }

  const timeout = Math.min(60000, (feRequest.timeout ?? 30000) + 10000);
  const startTime = Date.now();

  const mirrorPromise = (async (): Promise<MirrorResult> => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeout);
    let jobId: string | undefined;

    try {
      abLogger.info("A/B-testing fire-engine to staging", {
        url: feRequest.url,
      });

      let response = await robustFetch({
        url: `${config.FIRE_ENGINE_AB_URL}/scrape`,
        method: "POST",
        body: feRequest,
        logger: abLogger,
        tryCount: 1,
        ignoreResponse: false,
        ignoreFailureStatus: true,
        mock: null,
        abort: abortController.signal,
      });

      jobId = response?.jobId;

      if (!response.content && response.docUrl) {
        const doc = await getDocFromGCS(response.docUrl.split("/").pop() ?? "");
        if (doc) {
          response = { ...response, ...doc };
        }
      }

      abLogger.info("A/B-testing fire-engine (staging) request completed", {
        url: feRequest.url,
        hasContent: !!response?.content,
      });

      const feResponse: FireEngineResponse | null =
        response &&
        typeof response.content === "string" &&
        typeof response.pageStatusCode === "number"
          ? {
              content: response.content,
              pageStatusCode: response.pageStatusCode,
            }
          : null;

      return {
        response: feResponse,
        error: feResponse ? null : new Error("Invalid response format"),
        timeTaken: Date.now() - startTime,
      };
    } catch (error) {
      abLogger.warn("A/B-testing fire-engine (staging) failed", {
        error,
        url: feRequest.url,
      });
      return {
        response: null,
        error: error as Error,
        timeTaken: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutHandle);

      if (jobId && config.FIRE_ENGINE_AB_URL) {
        robustFetch({
          url: `${config.FIRE_ENGINE_AB_URL}/scrape/${jobId}`,
          method: "DELETE",
          headers: {},
          logger: abLogger.child({ method: "abTestFireEngine/delete", jobId }),
          mock: null,
        }).catch(e => {
          abLogger.warn("Failed to delete AB test job from fire-engine", {
            error: e,
            jobId,
          });
        });
      }
    }
  })();

  return {
    mode: "mirror",
    mirrorPromise,
  };
}
