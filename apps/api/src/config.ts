import "dotenv/config";
import { z } from "zod";
import { getMcpActionLogConfigErrors } from "./lib/mcp-action-log-config";

/* Codecs */
const delimitedList = (separator = ",") => {
  return z.codec(z.string(), z.array(z.string()), {
    decode: str => (str ? str.split(separator).map(s => s.trim()) : []),
    encode: arr => arr.join(separator),
  });
};

const emptyStringAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => (value === "" ? undefined : value), schema.optional());

const emptyStringAsDefault = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => (value === "" ? undefined : value), schema);

const RESEARCH_PAPER_OPERATIONS = [
  "search",
  "inspect",
  "read",
  "similar",
] as const;

export type ResearchPaperOperation = (typeof RESEARCH_PAPER_OPERATIONS)[number];

const researchKeylessDisabled = z.preprocess(
  value => {
    if (typeof value !== "string") return value;
    const raw = value.trim().toLowerCase();
    if (raw === "") return undefined;
    if (["false", "0", "off", "no", "none"].includes(raw)) return [];
    if (["true", "1", "on", "yes", "all"].includes(raw)) {
      return [...RESEARCH_PAPER_OPERATIONS];
    }
    return raw
      .split(",")
      .map(operation => operation.trim())
      .filter(Boolean);
  },
  z
    .array(z.enum(RESEARCH_PAPER_OPERATIONS))
    .default([...RESEARCH_PAPER_OPERATIONS]),
);

const containsLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return true;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
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
  FIRECRAWL_DASHBOARD_URL: z.url().default("https://www.firecrawl.dev"),
  SUPPORT_AGENT_URL: z.string().url().optional(),
  SUPPORT_AGENT_VERCEL_BYPASS_SECRET: z.string().optional(),
  FIREBRAIN_TRACKS_URL: z.preprocess(
    v => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  FIREBRAIN_TRACKS_API_KEY: z.preprocess(
    v => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().optional(),
  ),
  RESEARCH_PROXY_URL: z.string().url().optional(),
  RESEARCH_KEYLESS_DISABLED: researchKeylessDisabled,
  LABS_SEARCH_URL: z.string().url().optional(),
  LABS_SEARCH_SECRET: z.string().optional(),

  // Express
  EXPRESS_TRUST_PROXY: z.coerce.number().optional(),

  // Keyless free tier (scrape/search/interact without an API key, per-IP/day).
  // Non-negative integers; 0 means "enabled but no budget", unset means "off".
  KEYLESS_CREDITS_PER_DAY: z.coerce.number().int().nonnegative().optional(),
  KEYLESS_REQUESTS_PER_DAY: z.coerce.number().int().nonnegative().optional(),
  // Shared secret that lets a trusted proxy (e.g. the hosted MCP server)
  // forward the real client IP for keyless rate-limiting via the
  // `x-firecrawl-keyless-ip` header. Untrusted callers can't override their IP.
  KEYLESS_PROXY_SECRET: z.string().optional(),
  // Dedicated HMAC key for joining keyless quota-exhaustion events to the
  // existing privacy-controlled conversion pipeline. Never use the proxy or
  // credential secrets here: this value is only an analytics pseudonymizer.
  KEYLESS_CONVERSION_HMAC_SECRET: emptyStringAsUndefined(z.string().min(32)),
  // Dedicated signer/verifier secret for short-lived MCP delegated credentials.
  // Keep separate from KEYLESS_PROXY_SECRET because delegated credentials can
  // authorize billed requests for a managed OAuth connection.
  MCP_DELEGATED_CREDENTIAL_SECRET: emptyStringAsUndefined(z.string().min(32)),
  // Optional Spur Context API token (https://docs.spur.us/context-api). When
  // set, keyless requests have their client IP checked against Spur and are
  // refused if the IP fronts anonymizing/rotating infrastructure (VPN/proxy/
  // TOR). Unset disables the check entirely (keyless behaves as before).
  SPUR_API_KEY: z.string().optional(),

  // Threat protection (enterprise domain risk blocking). "normal" mode uses
  // Google Web Risk. An unset key disables the provider (lookups then fail
  // per the org's failurePolicy).
  GOOGLE_WEB_RISK_API_KEY: z.string().optional(),
  GOOGLE_WEB_RISK_API_URL: z
    .string()
    .url()
    .default("https://webrisk.googleapis.com"),
  // Google Web Risk Update API sync tuning. ZDR: "normal" mode checks run
  // against a locally synced hash-prefix database (threatLists:computeDiff)
  // instead of sending URLs to Google, and verdicts are never persisted.
  //
  // Floor for how often threatLists:computeDiff may run per list. Google's
  // recommendedNextDiff is respected when it is later than this floor.
  THREAT_LIST_SYNC_MIN_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  // A synced threat list older than this is treated as unavailable
  // (provider-failure semantics → the org's failurePolicy decides).
  THREAT_LIST_STALENESS_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * 60 * 60),

  // Zscaler ZIA provider ("zscaler" threat protection mode). Base-URL
  // overrides exist for tests (mock ZIA server); production always uses the
  // real endpoints derived from the org's vanity domain and cloud name.
  ZSCALER_TOKEN_URL_OVERRIDE: z.string().url().optional(),
  ZSCALER_API_URL_OVERRIDE: z.string().url().optional(),

  // Organization SIEM logging delivery. The encryption key must decode to
  // exactly 32 bytes; validation happens when a secret is encrypted/decrypted
  // so self-hosted deployments that do not use this feature need no key.
  SIEM_LOGGING_ENCRYPTION_KEY: z.string().optional(),
  PARTNER_EGRESS_PROXY_URL: z.string().url().optional(),

  // API Keys & Authentication
  BULL_AUTH_KEY: z.string().optional(),
  S2S_FIRECRAWL_INTEGRATIONS_TO_FIRECRAWL_API_KEY: emptyStringAsUndefined(
    z.string().trim().min(1),
  ),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  LLAMAPARSE_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  AUTUMN_SECRET_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  PREVIEW_TOKEN: z.string().optional(),
  SEARCH_PREVIEW_TOKEN: z.string().optional(),
  SEARCH_SERVICE_API_SECRET: z.string().optional(),
  SEARCH_FEEDBACK_MAX_AGE_SEC: z.coerce.number().int().positive().default(120),
  SEARCH_FEEDBACK_DAILY_CAP_CREDITS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(100),
  FEEDBACK_MAX_AGE_SEC: z.coerce.number().int().positive().default(120),
  FEEDBACK_DAILY_CAP_CREDITS: z.coerce.number().int().nonnegative().default(50),
  FEEDBACK_REFUND_ENABLED: z.stringbool().default(true),

  // OAuth token introspection
  OAUTH_INTROSPECT_URL: z.string().optional(),
  OAUTH_INTROSPECT_SECRET: z.string().optional(),
  MCP_ACTION_LOG_SECRET: z.string().optional(),
  MCP_ACTION_LOG_STORAGE_ENABLED: z.stringbool().default(false),
  MCP_ACTION_LOG_WRITES_ENABLED: z.stringbool().default(false),

  // Agent auth discovery (RFC 9728 WWW-Authenticate on 401)
  AGENT_AUTH_RESOURCE_METADATA_URL: z
    .url()
    .default("https://www.firecrawl.dev/.well-known/oauth-protected-resource"),

  // Database & Storage
  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.string().default("5432"),
  POSTGRES_DB: z.string().default("postgres"),
  POSTGRES_USER: z.string().default("postgres"),
  POSTGRES_PASSWORD: z.string().default("postgres"),
  DATABASE_URL: z.string().optional(),
  DATABASE_REPLICA_URL: z.string().optional(),
  INDEX_DATABASE_URL: z.string().optional(),
  // Pool sizing preset for this process (see db/pool-profiles.ts). Unset keeps
  // the historical pool settings; deployments opt into `api`, `worker` or
  // `utility` to keep connections warm within the pooler's client budget.
  DB_POOL_PROFILE: emptyStringAsUndefined(z.enum(["api", "worker", "utility"])),
  INDEX_CACHE_REDIS_URL: z.string().optional(),
  // Negative (miss) caching TTL for index URL->id lookups, in ms. 0 disables
  // it; the cache then only shields lookups that find data. A positive value
  // (e.g. 600000 = 10min) also short-circuits repeat lookups for URLs with no
  // index entry. Kept short so any missed cache-clear self-heals quickly.
  INDEX_CACHE_NEGATIVE_TTL_MS: z.coerce.number().default(0),
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

  // Google Cloud Storage
  GCS_BUCKET_NAME: z.string().optional(),
  GCS_CREDENTIALS: z.string().optional(),
  GCS_FIRE_ENGINE_BUCKET_NAME: z.string().optional(),
  GCS_INDEX_BUCKET_NAME: z.string().optional(),
  GCS_MEDIA_BUCKET_NAME: z.string().optional(),
  GCS_SCREENSHOT_RESIGN_BEFORE: emptyStringAsUndefined(z.string().datetime()),
  GCS_PARSE_UPLOAD_BUCKET_NAME: z.string().optional(),
  PARSE_UPLOAD_STORAGE_DRIVER: z.enum(["local", "gcs"]).optional(),
  PARSE_UPLOAD_REF_SECRET: emptyStringAsUndefined(z.string().trim().min(1)),
  PARSE_UPLOAD_PUBLIC_BASE_URL: z.string().url().optional(),

  // Cloud Bigtable (change tracking bookkeeping store). The client
  // auto-detects BIGTABLE_EMULATOR_HOST, so local dev only needs the
  // emulator plus these vars. BIGTABLE_CREDENTIALS mirrors
  // GCS_CREDENTIALS: base64-encoded service-account JSON; unset falls
  // back to Application Default Credentials.
  BIGTABLE_PROJECT_ID: z.string().optional(),
  BIGTABLE_INSTANCE_ID: z.string().optional(),
  BIGTABLE_APP_PROFILE_ID: z.string().optional(),
  BIGTABLE_CHANGE_TRACKING_TABLE: z.string().optional(),
  BIGTABLE_CREDENTIALS: z.string().optional(),

  // ClickHouse (Search Analytics)
  CLICKHOUSE_ANALYTICS_URL: z.string().optional(),
  CLICKHOUSE_ANALYTICS_DATABASE: z.string().optional(),

  // Search highlights: highlighter service base URL. TOKEN is optional
  // bearer auth for legacy/external services; the in-cluster service omits it.
  HIGHLIGHT_MODEL_URL: z.string().optional(),
  HIGHLIGHT_MODEL_TOKEN: z.string().optional(),
  // Stable percentage of non-MCP/CLI cohorts whose generated highlights are
  // returned. The remaining eligible traffic still runs in shadow mode.
  HIGHLIGHT_ROLLOUT_PERCENT: z.coerce.number().min(0).max(100).default(0),

  // Exchange (routed data sources service)
  FIRE_EXCHANGE_URL: z.url().optional(),

  // Fire Engine
  FIRE_ENGINE_BETA_URL: z.string().optional(),
  FIRE_ENGINE_STAGING_URL: z.string().optional(),
  FIRE_ENGINE_AB_URL: z.string().optional(),
  FIRE_ENGINE_AB_RATE: z.coerce.number().optional(),
  FIRE_ENGINE_AB_MODE: z.enum(["mirror", "split"]).default("mirror"),

  // Indexer
  INDEXER_RABBITMQ_URL: z.string().optional(),
  INDEXER_TRAFFIC_SHARE: z.coerce.number().default(0.0),

  // ScrapeURL
  SCRAPEURL_AB_HOST: z.string().optional(),
  SCRAPEURL_AB_RATE: z.coerce.number().optional(),
  SCRAPEURL_AB_EXTEND_MAXAGE: z.stringbool().optional(),
  SCRAPEURL_ENGINE_WATERFALL_DELAY_MS: z.coerce.number().default(0),

  // Scrape Retry Limits
  SCRAPE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  SCRAPE_MAX_FEATURE_TOGGLES: z.coerce.number().int().positive().default(3),
  SCRAPE_MAX_FEATURE_REMOVALS: z.coerce.number().int().positive().default(3),
  SCRAPE_MAX_PDF_PREFETCHES: z.coerce.number().int().positive().default(2),
  SCRAPE_MAX_DOCUMENT_PREFETCHES: z.coerce.number().int().positive().default(2),
  // Max concurrent native PDF extractions per process. Each extraction holds
  // the (≤50MB) PDF plus its parsed text/markdown in memory on a tokio blocking
  // thread; unbounded concurrency OOM-killed pods when several large PDFs
  // landed on one process at once. 3 keeps the worst-case transient memory
  // (~3 × ~0.5GB) well under the 8G limit while being far above typical demand
  // (per-pod average concurrency is ~0.02).
  PDF_EXTRACTION_CONCURRENCY: z.coerce.number().int().positive().default(3),

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
  NUQ_RECONCILER_WORKER_PORT: z.coerce.number().default(3012).catch(3012),
  CCLOG_WORKER_PORT: z.coerce.number().default(3013).catch(3013),
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

  // MinerU direct routing (bypass Rust extraction for a % of traffic)
  MINERU_PERCENT: z.coerce.number().min(0).max(100).default(0),

  // Fire PDF (replaces MinerU for a % of traffic)
  FIRE_PDF_ENABLE: z.stringbool().optional(),
  FIRE_PDF_PERCENT: z.coerce.number().min(0).max(100).default(10),
  FIRE_PDF_BASE_URL: z.string().optional(),
  FIRE_PDF_API_KEY: z.string().optional(),
  // Async /jobs rollout is a separate, server-controlled cohort inside
  // traffic already selected for FirePDF. It is disabled by default.
  FIRE_PDF_ASYNC_PERCENT: z.coerce.number().min(0).max(100).default(0),
  // Separate cohort for crawl/batch-originated scrapes (any scrape
  // carrying a crawlId): no caller waits on one specific document, so
  // these can ramp onto the async lane ahead of interactive traffic.
  FIRE_PDF_ASYNC_BULK_ORIGIN_PERCENT: z.coerce
    .number()
    .min(0)
    .max(100)
    .default(0),
  FIRE_PDF_ASYNC_FORCE_TEAM_IDS: z.string().optional(),
  FIRE_PDF_ASYNC_DISABLE_TEAM_IDS: z.string().optional(),
  FIRE_PDF_ASYNC_ALLOW_REQUEST_OVERRIDE: z.stringbool().default(false),
  // Large-PDF by-reference submits (30-256MB files uploaded to GCS and
  // handed to fire-pdf via `input_gcs_uri`). This is an explicit on/off
  // switch, not a percentage: no alternative engine exists at this size,
  // so there is no cohort to sample "out" — only text-only degradation.
  // FIRE_PDF_ENABLE remains the master switch for both paths.
  FIRE_PDF_BY_REFERENCE_ENABLE: z.stringbool().default(true),
  // Bucket that receives large-PDF inputs for by-reference async submits
  // (fire-pdf reads them back via `input_gcs_uri`). fire-pdf only accepts
  // URIs inside its own configured bucket + `inputs/` prefix, so this must
  // match fire-pdf's FIRE_PDF_GCS_BUCKET. Upload failures (e.g. missing
  // IAM grant) fall back to the pre-by-reference behavior for oversized
  // files rather than failing the scrape.
  FIRE_PDF_GCS_INPUT_BUCKET: z
    .string()
    .trim()
    .min(1)
    .default("firecrawl-pdf-pipeline"),
  // Bucket fire-engine uses for its large-PDF handoff (files too big to
  // inline as base64 in its response). Acts as the allowlist for inbound
  // `file.gcs_uri` references — objects outside it are never fetched or
  // copied. Deliberately no default: this is a security-sensitive inbound
  // allowlist, so consuming references requires explicit opt-in (set to
  // fire-engine's GCS_PDF_BUCKET_NAME); unset disables the path.
  FIRE_ENGINE_PDF_GCS_BUCKET: emptyStringAsUndefined(z.string().trim().min(1)),
  // Large-PDF size policy, applied per team on every acquisition path
  // (direct download, fire-engine handoff, by-reference submit) and sent to
  // fire-engine as the per-request pdfMaxSize. The default applies to every
  // team; ids on the allowlist get the privileged cap. Both are clamped to
  // the 256MB architectural ceiling.
  PDF_BY_REFERENCE_MAX_BYTES_DEFAULT: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),
  // Comma-separated team ids granted the privileged cap.
  PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS: z.string().optional(),

  // RunPod
  RUNPOD_MU_API_KEY: z.string().optional(),
  RUNPOD_MU_POD_ID: z.string().optional(),

  // PDF Rust Extraction (pdf-inspector)
  PDF_RUST_EXTRACT_ENABLE: z.stringbool().optional(),
  PDF_SHADOW_COMPARISON_ENABLE: z.stringbool().optional(),

  // Webhooks
  SELF_HOSTED_WEBHOOK_URL: z.string().optional(),
  SELF_HOSTED_WEBHOOK_HMAC_SECRET: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().optional(),
  SLACK_ADMIN_WEBHOOK_URL: z.string().optional(),
  DISABLE_WEBHOOK_DELIVERY: z.stringbool().optional(),

  // Slack integration ("Add to Slack" for monitor notifications + /monitor
  // slash command). Credentials come from the Firecrawl Slack app.
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  // Bot scopes requested during install. Override only if the Slack app manifest
  // changes; keep in sync with slack-app-manifest.json.
  SLACK_OAUTH_SCOPES: z
    .string()
    .default(
      "chat:write,chat:write.public,commands,channels:read,groups:read,team:read,incoming-webhook",
    ),
  // Absolute URL Slack redirects back to after authorize. Must exactly match a
  // Redirect URL configured on the Slack app (e.g.
  // https://api.firecrawl.dev/v2/slack/oauth/callback).
  SLACK_OAUTH_REDIRECT_URL: z.string().optional(),
  // 32-byte key (hex or base64) used to AES-256-GCM encrypt stored bot tokens.
  // If unset, tokens are stored with a `plain:` prefix (self-hosted only).
  SLACK_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  ALLOW_LOCAL_WEBHOOKS: z.stringbool().optional(),
  WEBHOOK_USE_RABBITMQ: z.stringbool().optional(),

  // Firecrawl Features
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

  // LangSmith (tracing for interact agent)
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGSMITH_TRACING: z.stringbool().optional(),

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

  // Billing
  AUTO_RECHARGE_ENABLED: z.stringbool().default(false),
  // firebill — durable usage-event store that sits in front of Autumn. When
  // both URL and SECRET are set, usage tracking for orgs listed in
  // FIREBILL_ORG_IDS (comma-separated org UUIDs) is routed through firebill
  // instead of directly to Autumn (gradual rollout).
  FIREBILL_URL: emptyStringAsUndefined(z.string().url()),
  FIREBILL_SECRET: emptyStringAsUndefined(z.string().trim().min(1)),
  FIREBILL_ORG_IDS: delimitedList(",").optional(),
  // How long "this team is not partner-provisioned" is trusted. Only the
  // negative is bounded: provisioning is one-way, so a positive cannot go
  // stale, while a negative does the moment a partner provisions an account.
  // Capped at firebill's own gateway lookup TTL (300s) — the two sides answer
  // the same question, and trusting a negative for longer than firebill trusts
  // an answer turns this cache back into the stale allowlist it replaced. 0
  // disables caching negatives entirely.
  FIREBILL_GATEWAY_NEGATIVE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(300)
    .default(60),
  // Sticky percentage ramp, on top of the allowlist above. The bucket is a
  // hash of the org id, so an org that is in at 5 is still in at 30 — a ramp
  // only ever adds, and never reshuffles who is on which path mid-rollout.
  // 0 (the default) is also the kill switch: the allowlist still routes, and
  // nothing else does.
  FIREBILL_ROLLOUT_PERCENT: z.coerce.number().min(0).max(100).default(0),

  // Miscellaneous
  IDMUX_URL: z.string().optional(),
  GITHUB_RUN_NUMBER: z.string().optional(),
  GITHUB_REF_NAME: z.string().optional(),
  RESTRICTED_COUNTRIES: delimitedList(",").optional(),
  DISABLE_ENGPICKER: z.stringbool().optional(),
  DISABLE_MONITORING: z.stringbool().default(false),

  EXTRACT_V3_BETA_URL: z.string().optional(),
  AGENT_INTEROP_SECRET: z
    .string()
    .refine(value => value.trim().length > 0, {
      error: "AGENT_INTEROP_SECRET must not be blank",
    })
    .refine(value => !containsLoneSurrogate(value), {
      error: "AGENT_INTEROP_SECRET must not contain lone surrogates",
    })
    .optional(),

  // Wikipedia Enterprise API
  WIKIPEDIA_ENTERPRISE_USERNAME: z.string().optional(),
  WIKIPEDIA_ENTERPRISE_PASSWORD: z.string().optional(),

  // Browser Service
  BROWSER_SERVICE_URL: z.string().optional(),
  BROWSER_SERVICE_API_KEY: z.string().optional(),
  BROWSER_SERVICE_WEBHOOK_SECRET: z.string().optional(),

  // Audio (avgrab)
  AVGRAB_SERVICE_URL: z.string().optional(),

  // Product extraction (product-search Rust service)
  PRODUCT_EXTRACTION_SERVICE_URL: z.string().optional(),

  // Menu extraction (menu-search Rust service)
  MENU_EXTRACTION_SERVICE_URL: z.string().optional(),

  // PII Redaction (fire-privacy)
  FIRE_PRIVACY_URL: z.string().optional(),
  FIRE_PRIVACY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  NUQ_PREFETCH_WORKER_HEARTBEAT_URL: z.string().optional(),

  ZDRCLEANER_HEARTBEAT_URL: z.string().optional(),

  // Deterministic JSON extraction (reusable-json-mode)
  EXTRACT_CODEGEN_MODEL: z.string().default("gemini-3.1-flash-lite"),
  EXTRACT_ANCHOR_MODEL: z.string().default("openai/gpt-oss-120b"),
  EXTRACT_LIGHT_MODEL: z.string().default("openai/gpt-oss-20b"),
  CODE_SANDBOX_URL: z.string().default("ws://code-sandbox:3001"),
});

const validatedConfigSchema = configSchema.superRefine((value, context) => {
  for (const error of getMcpActionLogConfigErrors(value)) {
    context.addIssue({
      code: "custom",
      path: [error.path],
      message: error.message,
    });
  }
});

export const config = validatedConfigSchema.parse(process.env);
