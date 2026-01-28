import "dotenv/config";
import { z } from "zod";

/* Codecs */
const delimitedList = (separator = ",") => {
  return z.codec(z.string(), z.array(z.string()), {
    decode: str => (str ? str.split(separator).map(s => s.trim()) : []),
    encode: arr => arr.join(separator),
  });
};

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

  // API Keys & Authentication
  BULL_AUTH_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  LLAMAPARSE_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  PREVIEW_TOKEN: z.string().optional(),
  SEARCH_PREVIEW_TOKEN: z.string().optional(),
  SEARCH_SERVICE_API_SECRET: z.string().optional(),

  // Database & Storage
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

  // ClickHouse
  CLICKHOUSE_URL: z.string().optional(),
  CLICKHOUSE_USERNAME: z.string().optional(),
  CLICKHOUSE_PASSWORD: z.string().optional(),
  CLICKHOUSE_DATABASE: z.string().optional(),

  // Supabase
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_TOKEN: z.string().optional(),
  SUPABASE_SERVICE_TOKEN: z.string().optional(),
  SUPABASE_REPLICA_URL: z.string().optional(),
  SUPABASE_ACUC_URL: z.string().optional(),
  SUPABASE_ACUC_SERVICE_TOKEN: z.string().optional(),
  INDEX_SUPABASE_URL: z.string().optional(),
  INDEX_SUPABASE_SERVICE_TOKEN: z.string().optional(),
  SEARCH_INDEX_SUPABASE_URL: z.string().optional(),

  // Google Cloud Storage
  GCS_BUCKET_NAME: z.string().optional(),
  GCS_CREDENTIALS: z.string().optional(),
  GCS_FIRE_ENGINE_BUCKET_NAME: z.string().optional(),
  GCS_INDEX_BUCKET_NAME: z.string().optional(),
  GCS_MEDIA_BUCKET_NAME: z.string().optional(),

  // Fire Engine
  FIRE_ENGINE_BETA_URL: z.string().optional(),
  FIRE_ENGINE_STAGING_URL: z.string().optional(),
  FIRE_ENGINE_AB_URL: z.string().optional(),
  FIRE_ENGINE_AB_RATE: z.coerce.number().optional(),
  FIRE_ENGINE_AB_COMPARE_ENABLED: z.stringbool().default(false),

  // ScrapeURL
  SCRAPEURL_AB_HOST: z.string().optional(),
  SCRAPEURL_AB_RATE: z.coerce.number().optional(),
  SCRAPEURL_AB_EXTEND_MAXAGE: z.stringbool().optional(),
  SCRAPEURL_ENGINE_WATERFALL_DELAY_MS: z.coerce.number().default(0),

  // Search Services
  SEARXNG_ENDPOINT: z.string().optional(),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_CATEGORIES: z.string().optional(),
  SEARCH_SERVICE_URL: z.string().optional(),
  SEARCH_INDEX_SAMPLE_RATE: z.coerce.number().default(0.1),
  ENABLE_SEARCH_INDEX: z.stringbool().optional(),

  // Worker Configuration
  WORKER_PORT: z.coerce.number().default(3005),
  NUQ_WORKER_PORT: z.coerce.number().default(3000).catch(3000), // todo: investigate why .catch is needed
  NUQ_WORKER_START_PORT: z.coerce.number().default(3006),
  NUQ_WORKER_COUNT: z.coerce.number().default(5),
  NUQ_PREFETCH_WORKER_PORT: z.coerce.number().default(3011).catch(3011), // todo: investigate why .catch is needed
  EXTRACT_WORKER_PORT: z.coerce.number().default(3004),
  NUQ_WAIT_MODE: z.string().optional(),

  // Harness Configuration
  HARNESS_STARTUP_TIMEOUT_MS: z.coerce.number().default(60000),

  // Job & Lock Management
  JOB_LOCK_EXTEND_INTERVAL: z.coerce.number().default(10000),
  JOB_LOCK_EXTENSION_TIME: z.coerce.number().default(60000),
  WORKER_LOCK_DURATION: z.coerce.number().default(60000),
  WORKER_STALLED_CHECK_INTERVAL: z.coerce.number().default(30000),
  CONNECTION_MONITOR_INTERVAL: z.coerce.number().default(10),
  CANT_ACCEPT_CONNECTION_INTERVAL: z.coerce.number().default(2000),

  // Proxy
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),

  // External Services
  PLAYWRIGHT_MICROSERVICE_URL: z.string().optional(),
  HTML_TO_MARKDOWN_SERVICE_URL: z.string().optional(),
  SMART_SCRAPE_API_URL: z.string().optional(),

  // PDF Processing
  PDF_MU_V2_BASE_URL: z.string().optional(),
  PDF_MU_V2_API_KEY: z.string().optional(),
  PDF_MU_V2_EXPERIMENT: z.string().optional(),
  PDF_MU_V2_EXPERIMENT_PERCENT: z.coerce.number().default(100),

  // RunPod
  RUNPOD_MU_API_KEY: z.string().optional(),
  RUNPOD_MU_POD_ID: z.string().optional(),

  // Webhooks
  SELF_HOSTED_WEBHOOK_URL: z.string().optional(),
  SELF_HOSTED_WEBHOOK_HMAC_SECRET: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
  SLACK_ADMIN_WEBHOOK_URL: z.string().optional(),
  DISABLE_WEBHOOK_DELIVERY: z.stringbool().optional(),
  ALLOW_LOCAL_WEBHOOKS: z.stringbool().optional(),
  WEBHOOK_USE_RABBITMQ: z.stringbool().optional(),

  // Firecrawl Features
  FIRECRAWL_FDW_ENABLED: z.stringbool().default(false),
  FIRECRAWL_DEBUG_FILTER_LINKS: z.stringbool().optional(),
  FIRECRAWL_LOG_TO_FILE: z.stringbool().optional(),
  FIRECRAWL_SAVE_MOCKS: z.stringbool().optional(),
  FIRECRAWL_INDEX_WRITE_ONLY: z.stringbool().optional(),
  DISABLE_BLOCKLIST: z.stringbool().optional(),
  FORCED_ENGINE_DOMAINS: z.string().optional(),
  DEBUG_BRANDING: z.stringbool().optional(),

  // AI/ML
  MODEL_NAME: z.string().optional(),
  MODEL_EMBEDDING_NAME: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  VERTEX_CREDENTIALS: z.string().optional(),

  // Rate Limiting
  RATE_LIMIT_TEST_API_KEY_SCRAPE: z.coerce.number().optional(),
  RATE_LIMIT_TEST_API_KEY_CRAWL: z.coerce.number().optional(),

  // Testing
  TEST_API_KEY: z.string().optional(),
  TEST_API_URL: z.string().default("http://127.0.0.1:3002"),
  TEST_TEAM_ID: z.string().optional(),
  TEST_SUITE_SELF_HOSTED: z.stringbool().optional(),
  TEST_SUITE_WEBSITE: z.string().default("http://127.0.0.1:4321"),
  USE_DB_AUTHENTICATION: z.stringbool().optional(),

  // Indexing
  BACKGROUND_INDEX_TEAM_ID: z.string().optional(),
  PRECRAWL_TEAM_ID: z.string().optional(),

  // Payment (x402)
  X402_ENDPOINT_PRICE_USD: z.string().optional(),
  X402_NETWORK: z.string().optional(),
  X402_PAY_TO_ADDRESS: z.string().optional(),

  // System
  MAX_CPU: z.coerce.number().default(0.8),
  MAX_RAM: z.coerce.number().default(0.8),
  SYS_INFO_MAX_CACHE_DURATION: z.coerce.number().default(150),
  USE_GO_MARKDOWN_PARSER: z.stringbool().optional(),

  // Sentry
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACE_SAMPLE_RATE: z.coerce.number().default(0.01),
  SENTRY_ERROR_SAMPLE_RATE: z.coerce.number().default(0.05),
  SENTRY_ENVIRONMENT: z.string().default("production"),
  NUQ_POD_NAME: z.string().default("main"),

  // Miscellaneous
  IDMUX_URL: z.string().optional(),
  GITHUB_RUN_NUMBER: z.string().optional(),
  GITHUB_REF_NAME: z.string().optional(),
  RESTRICTED_COUNTRIES: delimitedList(",").optional(),
  DISABLE_ENGPICKER: z.stringbool().optional(),

  EXTRACT_V3_BETA_URL: z.string().optional(),
  AGENT_INTEROP_SECRET: z.string().optional(),

  NUQ_PREFETCH_WORKER_HEARTBEAT_URL: z.string().optional(),
});

export const config = configSchema.parse(process.env);
