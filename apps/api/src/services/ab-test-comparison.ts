import { Logger } from "winston";

const AB_LOG_PREFIX = "[FE_AB_COMPARE]";
const MAX_CONTENT_SIZE = 1_000_000; // 1 MB
const VARIANCE_THRESHOLD = 0.05; // 5% allowed variance

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

function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const maxLen = Math.max(a.length, b.length);
  const minLen = Math.min(a.length, b.length);

  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) matches++;
  }

  return matches / maxLen;
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

      const similarity = calculateSimilarity(prodNormalized, mirrorNormalized);
      const withinVariance = similarity >= 1 - VARIANCE_THRESHOLD;

      const timeDiff = mirrorResult.timeTaken - productionTimeTaken;
      const timeDiffStr = timeDiff >= 0 ? `+${timeDiff}ms` : `${timeDiff}ms`;

      if (withinVariance) {
        abLogger.info(
          `${AB_LOG_PREFIX} Content within variance (${timeDiffStr})`,
          {
            ...baseLogData,
            similarity: `${(similarity * 100).toFixed(2)}%`,
          },
        );
      } else {
        abLogger.info(`${AB_LOG_PREFIX} Content mismatch (${timeDiffStr})`, {
          ...baseLogData,
          prod_len: prodNormalized.length,
          mirror_len: mirrorNormalized.length,
          similarity: `${(similarity * 100).toFixed(2)}%`,
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
