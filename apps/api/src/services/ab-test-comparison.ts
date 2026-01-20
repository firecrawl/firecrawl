import { Logger } from "winston";

const AB_LOG_PREFIX = "[FE_AB_COMPARE]";
const MAX_CONTENT_SIZE = 1_000_000; // 1 MB

export interface FireEngineResponse {
  content: string;
  pageStatusCode: number;
}

export interface MirrorResult {
  response: FireEngineResponse | null;
  error: Error | null;
  timeTaken: number;
}

function normalizeContent(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function scheduleABComparison(
  url: string,
  productionResponse: FireEngineResponse,
  productionTimeTaken: number,
  mirrorPromise: Promise<MirrorResult>,
  logger: Logger,
): void {
  const abLogger = logger.child({ method: "ABTestComparison" });

  mirrorPromise
    .then(mirrorResult => {
      const baseLogData = {
        url,
        prod_ms: productionTimeTaken,
        mirror_ms: mirrorResult.timeTaken,
        diff_ms: mirrorResult.timeTaken - productionTimeTaken,
      };

      if (mirrorResult.error || !mirrorResult.response) {
        abLogger.warn(`${AB_LOG_PREFIX} Mirror request failed`, {
          ...baseLogData,
          error: mirrorResult.error?.message ?? "unknown",
        });
        return;
      }

      // Skip comparison if content too large
      if (
        productionResponse.content.length > MAX_CONTENT_SIZE ||
        mirrorResult.response.content.length > MAX_CONTENT_SIZE
      ) {
        return;
      }

      const prodNormalized = normalizeContent(productionResponse.content);
      const mirrorNormalized = normalizeContent(mirrorResult.response.content);
      const identical = prodNormalized === mirrorNormalized;

      if (identical) {
        abLogger.info(`${AB_LOG_PREFIX} Content identical`, baseLogData);
      } else {
        abLogger.warn(`${AB_LOG_PREFIX} Content mismatch`, {
          ...baseLogData,
          prod_len: productionResponse.content.length,
          mirror_len: mirrorResult.response.content.length,
          prod_status: productionResponse.pageStatusCode,
          mirror_status: mirrorResult.response.pageStatusCode,
        });
      }
    })
    .catch(error => {
      abLogger.error(`${AB_LOG_PREFIX} Comparison failed unexpectedly`, {
        error,
        url,
      });
    });
}
