import type { Logger } from "winston";
import {
  ScrapeRetryLimitError,
  ScrapeRetryLimitReason,
  ScrapeRetryStats,
} from "./error";

type RetryReason = Exclude<ScrapeRetryLimitReason, "global">;

interface ScrapeRetryTrackerConfig {
  maxAttempts: number;
  maxFeatureToggles: number;
  maxFeatureRemovals: number;
  maxPdfPrefetches: number;
  maxDocumentPrefetches: number;
}

export class ScrapeRetryTracker {
  private stats: ScrapeRetryStats = {
    totalAttempts: 0,
    addFeatureAttempts: 0,
    removeFeatureAttempts: 0,
    pdfAntibotAttempts: 0,
    documentAntibotAttempts: 0,
    pdfFetchProxyAttempts: 0,
    documentFetchProxyAttempts: 0,
  };

  constructor(
    private readonly config: ScrapeRetryTrackerConfig,
    private readonly logger: Logger,
  ) {}

  getSnapshot(): ScrapeRetryStats {
    return { ...this.stats };
  }

  record(reason: RetryReason, lastError: unknown) {
    this.stats.totalAttempts += 1;
    if (this.stats.totalAttempts > this.config.maxAttempts) {
      this.throwLimit("global", lastError);
    }

    switch (reason) {
      case "feature_toggle":
        this.stats.addFeatureAttempts += 1;
        if (this.stats.addFeatureAttempts > this.config.maxFeatureToggles) {
          this.throwLimit(reason, lastError);
        }
        break;
      case "feature_removal":
        this.stats.removeFeatureAttempts += 1;
        if (this.stats.removeFeatureAttempts > this.config.maxFeatureRemovals) {
          this.throwLimit(reason, lastError);
        }
        break;
      case "pdf_antibot":
      case "pdf_fetch_proxy": {
        if (reason === "pdf_antibot") {
          this.stats.pdfAntibotAttempts += 1;
        } else {
          this.stats.pdfFetchProxyAttempts += 1;
        }
        // Antibot and proxy-failure retries consume the same resource — one
        // browser-engine prefetch round trip — so they share the budget: a
        // scrape must not be granted maxPdfPrefetches of EACH.
        if (
          this.stats.pdfAntibotAttempts + this.stats.pdfFetchProxyAttempts >
          this.config.maxPdfPrefetches
        ) {
          this.throwLimit(reason, lastError);
        }
        break;
      }
      case "document_antibot":
      case "document_fetch_proxy": {
        if (reason === "document_antibot") {
          this.stats.documentAntibotAttempts += 1;
        } else {
          this.stats.documentFetchProxyAttempts += 1;
        }
        // Same shared-budget rationale as the PDF counters above.
        if (
          this.stats.documentAntibotAttempts +
            this.stats.documentFetchProxyAttempts >
          this.config.maxDocumentPrefetches
        ) {
          this.throwLimit(reason, lastError);
        }
        break;
      }
    }

    this.logger.warn("scrapeURL retrying after handled error", {
      reason,
      retryStats: this.getSnapshot(),
      lastError:
        lastError instanceof Error ? lastError.message : (lastError ?? null),
    });
  }

  private throwLimit(reason: ScrapeRetryLimitReason, lastError: unknown) {
    const snapshot = this.getSnapshot();
    this.logger.error("scrapeURL retry limit reached", {
      reason,
      retryStats: snapshot,
      lastError:
        lastError instanceof Error ? lastError.message : (lastError ?? null),
    });
    throw new ScrapeRetryLimitError(reason, snapshot);
  }
}
