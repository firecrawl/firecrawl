import { ScrapeJobData } from "../types";
import { logger as _logger } from "../lib/logger";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";
import { config } from "../config";

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
