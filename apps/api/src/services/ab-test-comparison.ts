import { Logger } from "winston";
import { parseMarkdown } from "../lib/html-to-markdown";

const AB_LOG_PREFIX = "[FE_AB_COMPARE]";
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

function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return intersection / union;
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
    .then(async mirrorResult => {
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

      // Convert HTML to markdown before comparing
      const [prodMarkdown, mirrorMarkdown] = await Promise.all([
        parseMarkdown(productionResponse.content, { logger: abLogger }),
        parseMarkdown(mirrorResult.response.content, { logger: abLogger }),
      ]);

      const similarity = calculateSimilarity(prodMarkdown, mirrorMarkdown);
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
        abLogger.warn(`${AB_LOG_PREFIX} Content mismatch (${timeDiffStr})`, {
          ...baseLogData,
          prod_len: prodMarkdown.length,
          mirror_len: mirrorMarkdown.length,
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
