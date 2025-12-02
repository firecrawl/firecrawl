// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { logger } from "../lib/logger";

if (process.env.SENTRY_DSN) {
  logger.info("Setting up Sentry...");

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: integrations => [...integrations, nodeProfilingIntegration()],
    tracesSampleRate: 0,
    sampleRate: 0.05,
    serverName: process.env.NUQ_POD_NAME,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    skipOpenTelemetrySetup: true,
    beforeSend(event, hint) {
      const error = hint?.originalException;

      if (error && typeof error === "object") {
        const errorCode = "code" in error ? String(error.code) : "";

        const transportableErrorCodes = [
          "SCRAPE_ALL_ENGINES_FAILED",
          "SCRAPE_DNS_RESOLUTION_ERROR",
          "SCRAPE_SITE_ERROR",
          "SCRAPE_SSL_ERROR",
          "SCRAPE_PROXY_SELECTION_ERROR",
          "SCRAPE_ZDR_VIOLATION_ERROR",
          "SCRAPE_UNSUPPORTED_FILE_ERROR",
          "SCRAPE_PDF_ANTIBOT_ERROR",
          "SCRAPE_ACTION_ERROR",
          "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
          "SCRAPE_PDF_PREFETCH_FAILED",
          "SCRAPE_DOCUMENT_ANTIBOT_ERROR",
          "SCRAPE_DOCUMENT_PREFETCH_FAILED",
          "SCRAPE_TIMEOUT",
          "MAP_TIMEOUT",
          "SCRAPE_UNKNOWN_ERROR",
          "SCRAPE_RACED_REDIRECT_ERROR",
          "SCRAPE_SITEMAP_ERROR",
          "CRAWL_DENIAL",
        ];

        if (transportableErrorCodes.includes(errorCode)) {
          return null;
        }
      }

      return event;
    },
  });
}

/**
 * Set the service type tag for this Sentry instance
 * This helps distinguish between API server and worker errors in Sentry
 */
export function setSentryServiceTag(serviceType: string) {
  if (process.env.SENTRY_DSN) {
    Sentry.setTag("service_type", serviceType);
  }
}
