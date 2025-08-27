import { WebScraperOptions } from "../types";
import { logger as _logger } from "../lib/logger";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";

export function abTestJob(webScraperOptions: WebScraperOptions) {
    // Global A/B test: mirror request to staging /v1/scrape based on SCRAPEURL_AB_RATE
    const abLogger = _logger.child({ method: "ABTestToStaging" });
    try {
        const abRateEnv = process.env.SCRAPEURL_AB_RATE;
        const abHostEnv = process.env.SCRAPEURL_AB_HOST;
        const abRate = abRateEnv !== undefined ? Math.max(0, Math.min(1, Number(abRateEnv))) : 0;
        const shouldABTest = webScraperOptions.mode === "single_urls"
            && !webScraperOptions.zeroDataRetention
            && !webScraperOptions.internalOptions?.zeroDataRetention
            && abRate > 0
            && Math.random() <= abRate
            && abHostEnv
            && webScraperOptions.internalOptions?.v1Agent === undefined
            && webScraperOptions.internalOptions?.v1JSONAgent === undefined;
        if (shouldABTest) {
            (async () => {
                try {
                    abLogger.info("A/B-testing scrapeURL to staging");
                    const abort = AbortSignal.timeout(Math.min(60000, (webScraperOptions.scrapeOptions.timeout ?? 30000) + 10000));
                    await robustFetch({
                        url: `http://${abHostEnv}/v2/scrape`,
                        method: "POST",
                        body: {
                            url: webScraperOptions.url,
                            ...webScraperOptions.scrapeOptions,
                            origin: (webScraperOptions.scrapeOptions as any).origin ?? "api",
                        },
                        logger: abLogger,
                        tryCount: 1,
                        ignoreResponse: true,
                        mock: null,
                        abort,
                    });
                    abLogger.info("A/B-testing scrapeURL (staging) request sent");
                } catch (error) {
                    abLogger.warn("A/B-testing scrapeURL (staging) failed", { error });
                }
            })();
        }
    } catch (error) {
        abLogger.warn("Failed to initiate A/B test to staging", { error });
    }
}