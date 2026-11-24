/*
 * Unstable internal bridge for custom worker extensions while shared
 * subsystem modules still live in this package. Not imported by
 * `./service/index`, so constructing or describing a service never loads
 * these dependencies.
 */
export { getACUCTeam } from "../../controllers/auth";
export {
  crawlRequestSchema,
  scrapeOptions as scrapeOptionsSchema,
  toV0CrawlerOptions,
} from "../../controllers/v2/types";
export { queryTopUrlsForDomain } from "../../db/rpc";
export { reconcileBrowserSessions } from "../../lib/browser-lifecycle";
export { processBrowserSessionActivityJobs } from "../../lib/browser-session-activity";
export { requestContext } from "../../lib/request-context";
export { requestCreditsShards } from "../../lib/request-credits-store";
export { getSearchIndexClient } from "../../lib/search-index-client";
export { closeSiemLoggingTransport } from "../../lib/siem-logging/transport";
export {
  processBillingBatch,
  queueBillingOperation,
  startBillingBatchProcessing,
} from "../../services/billing/batch_billing";
export { resolveBillingMetadata } from "../../services/billing/types";
export {
  processIndexInsertJobs,
  queryDomainsForPrecrawl,
} from "../../services/index";
export {
  logRequest,
  shutdownPubSubLogging,
} from "../../services/logging/log_job";
export { _addScrapeJobToBullMQ } from "../../services/queue-jobs";
export { startSiemLoggingConsumer } from "../../services/siem-logging/worker";
export { default as systemMonitor } from "../../services/system-monitor";
export { processWebhookInsertJobs } from "../../services/webhook";
