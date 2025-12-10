import * as Sentry from "@sentry/node";
import { logger } from "../lib/logger";
import { config } from "../config";

type CaptureContext = {
  tags?: Record<string, string>;
  extra?: Record<string, any>;
  level?: Sentry.SeverityLevel;
  fingerprint?: string[];
  contexts?: Record<string, any>;
  user?: {
    id?: string;
    username?: string;
    email?: string;
    ip_address?: string;
    [key: string]: any;
  };
  [key: string]: any;
};

if (config.SENTRY_DSN) {
  logger.info("Setting up Sentry...");

  Sentry.init({
    dsn: config.SENTRY_DSN,
    integrations: integrations => [
      ...integrations,
      Sentry.vercelAIIntegration({
        recordInputs: false,
        recordOutputs: false,
      }),
    ],
    tracesSampler: samplingContext => {
      // trace all AI spans, sample 1% of all others
      return samplingContext.name?.startsWith("ai.")
        ? 1.0
        : config.SENTRY_TRACE_SAMPLE_RATE;
    },
    sampleRate: config.SENTRY_ERROR_SAMPLE_RATE,
    serverName: config.NUQ_POD_NAME,
    environment: config.SENTRY_ENVIRONMENT,
    beforeSend(event, hint) {
      const zeroDataRetention =
        event.tags?.zeroDataRetention === "true" ||
        event.tags?.zero_data_retention === "true" ||
        event.extra?.zeroDataRetention === true ||
        event.extra?.zero_data_retention === true;

      if (zeroDataRetention) {
        return null;
      }

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

export function captureExceptionWithZdrCheck(
  error: any,
  context?: (CaptureContext & { zeroDataRetention?: boolean }) | null,
) {
  const zeroDataRetention =
    context?.zeroDataRetention ??
    (context?.extra as any)?.zeroDataRetention ??
    (context?.data as any)?.zeroDataRetention;

  if (zeroDataRetention) {
    return;
  }

  const { zeroDataRetention: _zdr, ...sentryContext } = context || {};

  return Sentry.captureException(error, sentryContext);
}

export function applyZdrScope(zeroDataRetention?: boolean) {
  if (!zeroDataRetention) {
    return;
  }

  const scope = Sentry.getCurrentScope();
  scope.setTag("zeroDataRetention", "true");
  scope.setExtra("zeroDataRetention", true);
}

/**
 * Set the service type tag for this Sentry instance
 * This helps distinguish between API server and worker errors in Sentry
 */
export function setSentryServiceTag(serviceType: string) {
  if (config.SENTRY_DSN) {
    Sentry.setTag("service_type", serviceType);
  }
}
