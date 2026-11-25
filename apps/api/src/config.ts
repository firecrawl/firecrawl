import "dotenv/config";
import { z } from "zod";
import { emptyStringAsUndefined } from "./config-helpers";

export { emptyStringAsUndefined };

/* Codecs */
const delimitedList = (separator = ",") => {
  return z.codec(z.string(), z.array(z.string()), {
    decode: str => (str ? str.split(separator).map(s => s.trim()) : []),
    encode: arr => arr.join(separator),
  });
};

const emptyStringAsDefault = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => (value === "" ? undefined : value), schema);

/* Schema */
const configSchema = z.object({
  // Application
  ENV: z.string().optional(),
  HOST: z.string().default("localhost"),
  PORT: z.coerce.number().default(3002),
  IS_PRODUCTION: z.stringbool().optional(),
  IS_KUBERNETES: z.stringbool().optional(),
  FIRECRAWL_APP_HOST: z.string().default("firecrawl-app-service"),
  FIRECRAWL_APP_PORT: z.string().default("3002"),
  FIRECRAWL_APP_SCHEME: z.string().default("http"),
  LOGGING_LEVEL: z.string().optional(),

  // Express
  EXPRESS_TRUST_PROXY: z.coerce.number().optional(),

  // Admin & AI Keys
  BULL_AUTH_KEY: z.string().optional(),
  BULL_AUTH_KEY_PREVIOUS: emptyStringAsUndefined(z.string()),
  BULL_AUTH_KEY_PATH_ROUTES: emptyStringAsDefault(z.stringbool().default(true)),
  ADMIN_INTERNAL_PORT: emptyStringAsUndefined(
    z.coerce.number().int().positive().max(65535),
  ),
  ADMIN_INTERNAL_HOST: emptyStringAsDefault(z.string().default("localhost")),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),

  // Database, Queue & Redis
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.string().default("5432"),
  POSTGRES_DB: z.string().default("postgres"),
  POSTGRES_USER: z.string().default("postgres"),
  POSTGRES_PASSWORD: z.string().default("postgres"),
  REDIS_URL: z.string().optional(),
  REDIS_EVICT_URL: z.string().optional(),
  REDIS_RATE_LIMIT_URL: z.string().optional(),
  NUQ_DATABASE_URL: z.string().optional(),
  NUQ_DATABASE_URL_LISTEN: z.string().optional(),
  NUQ_RABBITMQ_URL: z.string().optional(),
  FDB_CLUSTER_FILE: emptyStringAsUndefined(z.string()),
  NUQ_BACKEND: emptyStringAsUndefined(z.enum(["pg", "fdb"])),
  NUQ_FDB_READY_SHARDS: emptyStringAsDefault(
    z.coerce.number().int().positive().default(2048),
  ),
  // 1 = strict (priority, FIFO) promotion order per team; raise for teams with
  // extreme finish rates at the cost of approximate cross-shard ordering
  NUQ_FDB_TEAM_PENDING_SHARDS: emptyStringAsDefault(
    z.coerce.number().int().positive().default(1),
  ),
  NUQ_FDB_TIME_BUCKETS: emptyStringAsDefault(
    z.coerce.number().int().positive().default(16),
  ),

  // Parse Uploads
  PARSE_UPLOAD_STORAGE_DRIVER: z.enum(["local", "gcs"]).optional(),
  PARSE_UPLOAD_REF_SECRET: emptyStringAsUndefined(z.string().trim().min(1)),
  PARSE_UPLOAD_PUBLIC_BASE_URL: z.string().url().optional(),

  // ScrapeURL & Retry Limits
  SCRAPEURL_ENGINE_WATERFALL_DELAY_MS: z.coerce.number().default(0),
  SCRAPE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  SCRAPE_MAX_FEATURE_TOGGLES: z.coerce.number().int().positive().default(3),
  SCRAPE_MAX_FEATURE_REMOVALS: z.coerce.number().int().positive().default(3),
  SCRAPE_MAX_PDF_PREFETCHES: z.coerce.number().int().positive().default(2),
  SCRAPE_MAX_DOCUMENT_PREFETCHES: z.coerce.number().int().positive().default(2),
  // Max concurrent native PDF extractions per process. Each extraction holds
  // the (<=50MB) PDF plus its parsed text/markdown in memory on a tokio blocking
  // thread; bounding concurrency prevents memory spikes when several large PDFs
  // land on one process at once.
  PDF_EXTRACTION_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // Search Services
  SEARXNG_ENDPOINT: z.string().optional(),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_CATEGORIES: z.string().optional(),

  // Worker Configuration
  WORKER_PORT: z.coerce.number().default(3005),
  NUQ_WORKER_PORT: z.coerce.number().default(3000).catch(3000),
  NUQ_WORKER_START_PORT: z.coerce.number().default(3006),
  NUQ_WORKER_COUNT: z.coerce.number().default(5),
  NUQ_PREFETCH_WORKER_PORT: z.coerce.number().default(3011).catch(3011),
  NUQ_RECONCILER_WORKER_PORT: z.coerce.number().default(3012).catch(3012),
  NUQ_WAIT_MODE: z.string().optional(),

  // Harness Configuration
  HARNESS_STARTUP_TIMEOUT_MS: z.coerce.number().default(60000),

  // Job & Lock Management
  JOB_LOCK_EXTEND_INTERVAL: z.coerce.number().default(10000),
  JOB_LOCK_EXTENSION_TIME: z.coerce.number().default(60000),

  // Proxy
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),

  // External Services
  PLAYWRIGHT_MICROSERVICE_URL: z.string().optional(),
  HTML_TO_MARKDOWN_SERVICE_URL: z.string().optional(),

  // PDF Rust Extraction (pdf-inspector)
  PDF_RUST_EXTRACT_ENABLE: z.stringbool().optional(),

  // Webhooks
  SELF_HOSTED_WEBHOOK_URL: z.string().optional(),
  SELF_HOSTED_WEBHOOK_HMAC_SECRET: z.string().optional(),
  DISABLE_WEBHOOK_DELIVERY: z.stringbool().optional(),
  ALLOW_LOCAL_WEBHOOKS: z.stringbool().optional(),

  // Firecrawl Features
  FIRECRAWL_DEBUG_FILTER_LINKS: z.stringbool().optional(),
  FIRECRAWL_LOG_TO_FILE: z.stringbool().optional(),
  FIRECRAWL_SAVE_MOCKS: z.stringbool().optional(),
  FORCED_ENGINE_DOMAINS: z.string().optional(),
  // Warn scrapes of search engine results pages (google.*/search, ...) that
  // /search returns those results directly (lib/serp-url.ts).
  // SERP_SCRAPE_WARNING turns it on for every team, SERP_SCRAPE_WARNING_TEAM_IDS
  // (comma-separated) for listed teams, and SERP_SCRAPE_WARNING_ROLLOUT_PERCENT
  // for a stable share of teams.
  SERP_SCRAPE_WARNING: emptyStringAsUndefined(z.stringbool()),
  SERP_SCRAPE_WARNING_TEAM_IDS: delimitedList(",").optional(),
  SERP_SCRAPE_WARNING_ROLLOUT_PERCENT: z.coerce
    .number()
    .min(0)
    .max(100)
    .default(0),

  // AI/ML
  MODEL_NAME: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),

  // Testing
  TEST_API_KEY: z.string().optional(),
  TEST_API_URL: z.string().default("http://127.0.0.1:3002"),
  TEST_SUITE_SELF_HOSTED: z.stringbool().optional(),
  TEST_SUITE_WEBSITE: z.string().default("http://127.0.0.1:4321"),

  // System & Observability
  USE_GO_MARKDOWN_PARSER: z.stringbool().optional(),
  SENTRY_ENVIRONMENT: z.string().default("production"),

  // OpenTelemetry. Tracing is off unless an OTLP endpoint is set; spans are then
  // exported over http/protobuf, sampled per OTEL_TRACES_SAMPLER (default
  // parentbased_always_on), and the SDK honors the standard
  // OTEL_EXPORTER_OTLP_* / OTEL_BSP_* / OTEL_RESOURCE_ATTRIBUTES variables.
  // Zero-data-retention spans are never exported (see otel-tracer).
  OTEL_EXPORTER_OTLP_ENDPOINT: emptyStringAsUndefined(z.string().url()),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: emptyStringAsUndefined(z.string().url()),
  OTEL_SERVICE_NAME: emptyStringAsUndefined(z.string()),
  OTEL_TRACES_SAMPLER: emptyStringAsUndefined(z.string()),
  OTEL_TRACES_SAMPLER_ARG: emptyStringAsUndefined(z.string()),
  NUQ_POD_NAME: z.string().default("main"),

  // Miscellaneous
  RESTRICTED_COUNTRIES: delimitedList(",").optional(),

  // Wikipedia Enterprise API
  WIKIPEDIA_ENTERPRISE_USERNAME: z.string().optional(),
  WIKIPEDIA_ENTERPRISE_PASSWORD: z.string().optional(),

  NUQ_PREFETCH_WORKER_HEARTBEAT_URL: z.string().optional(),
});

// Docker Compose and the example Helm chart pass an empty OPENAI_BASE_URL when
// the variable is not set, so an empty value counts as not set. @ai-sdk/openai
// reads the variable from the environment itself, for the default provider it
// creates when the package is loaded and in createOpenAI, and throws on an
// empty value. It is therefore removed here, and lib/generic-ai.ts imports
// this module before the package.
if (process.env.OPENAI_BASE_URL?.trim() === "") {
  delete process.env.OPENAI_BASE_URL;
}

export const config = configSchema.parse(process.env);
