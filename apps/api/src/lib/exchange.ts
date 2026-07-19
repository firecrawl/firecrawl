import { fetch } from "undici";
import { z } from "zod";

import { config } from "../config";
import type { FormatObject } from "../controllers/v2/types";
import { logger as rootLogger } from "./logger";

type OrganizationDataSourceAccessRecord = {
  status?: string | null;
  termsKey?: string | null;
  termsVersion?: string | null;
  termsAcceptedAt?: string | null;
  enabledAt?: string | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
};

type OrganizationDataSourceAccess = Record<
  string,
  OrganizationDataSourceAccessRecord | null | undefined
>;

type RouteInput = {
  url: string;
  formats?: FormatObject[] | unknown[];
  actions?: unknown[];
  headers?: Record<string, unknown>;
  waitFor?: number;
  mobile?: boolean;
  location?: unknown;
  proxy?: unknown;
  blockAds?: boolean;
  profile?: unknown;
  atsv?: boolean;
  minAge?: number;
  includeTags?: unknown[];
  excludeTags?: unknown[];
  zeroDataRetention?: boolean;
  lockdown?: boolean;
  flags?: {
    professionalProfileCompanyDataBeta?: boolean;
    organizationDataSourceAccess?: OrganizationDataSourceAccess | null;
  } | null;
};

export type ExchangeScrapeMetadata = {
  handled: true;
  creditsCost: number;
  accessEventId?: string;
  integrationId?: string;
};

export type ExchangeTerms = {
  key: string;
  version: string;
};

export type ExchangeProvider = {
  id: string;
  creditsCost: number;
  terms?: ExchangeTerms;
  routes: {
    domains: Set<string>;
    pathPrefixes: string[];
  }[];
};

// deterministicJson is deliberately unsupported: its extractor scripts run
// against page HTML, which Exchange responses do not carry.
const SUPPORTED_FORMATS = new Set(["markdown", "json"]);
const EXCHANGE_BETA_FLAG = "professionalProfileCompanyDataBeta";
const THIRD_PARTY_DATA_TERMS_REQUIRED_CODE = "THIRD_PARTY_DATA_TERMS_REQUIRED";
const THIRD_PARTY_DATA_TERMS_REQUIRED_MESSAGE =
  "An organization admin must accept this data source's terms before this URL can be processed.";

const EXCHANGE_PROVIDERS_PATH = "/v1/providers";
const EXCHANGE_PROVIDERS_TIMEOUT_MS = 2_000;
const EXCHANGE_PROVIDERS_TTL_MS = 60_000;
const EXCHANGE_PROVIDERS_FAILURE_TTL_MS = 30_000;

const exchangeProvidersSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z
      .object({
        id: z.string(),
        // No .catch() here: a malformed credit cost must reject the catalog
        // (keeping the last good one) rather than silently billing 0.
        creditsCost: z.number().int().nonnegative(),
        terms: z
          .object({
            key: z.string(),
            version: z.string(),
          })
          .optional(),
        capabilities: z
          .object({
            scrape: z
              .object({
                urlRoutes: z
                  .array(
                    z
                      .object({
                        domains: z.string().array(),
                        pathPrefixes: z.string().array(),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  ),
});

let cachedProviders:
  | {
      expiresAt: number;
      value: ExchangeProvider[] | null;
    }
  | undefined;
let providersRequest: Promise<ExchangeProvider[] | null> | undefined;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getExchangeBaseUrl(): string | null {
  if (!config.FIRE_EXCHANGE_URL) {
    return null;
  }

  return config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
}

function normalizeProviders(
  raw: z.infer<typeof exchangeProvidersSchema>,
): ExchangeProvider[] {
  return raw.data
    .map(provider => ({
      id: provider.id,
      creditsCost: provider.creditsCost,
      ...(provider.terms === undefined ? {} : { terms: provider.terms }),
      routes: (provider.capabilities.scrape?.urlRoutes ?? []).map(route => ({
        domains: new Set(route.domains.map(normalizeHost)),
        pathPrefixes: route.pathPrefixes.map(normalizePathPrefix),
      })),
    }))
    .filter(provider => provider.routes.length > 0);
}

async function fetchExchangeProviders(): Promise<ExchangeProvider[] | null> {
  const baseUrl = getExchangeBaseUrl();
  if (!baseUrl) {
    return null;
  }

  try {
    const response = await fetch(`${baseUrl}${EXCHANGE_PROVIDERS_PATH}`, {
      method: "GET",
      signal: AbortSignal.timeout(EXCHANGE_PROVIDERS_TIMEOUT_MS),
    });

    if (!response.ok) {
      rootLogger.warn("Exchange providers request failed", {
        statusCode: response.status,
      });
      return null;
    }

    const parsed = exchangeProvidersSchema.parse(await response.json());
    return normalizeProviders(parsed);
  } catch (error) {
    rootLogger.warn("Exchange providers request errored", { error });
    return null;
  }
}

async function getExchangeProviders(): Promise<ExchangeProvider[] | null> {
  if (cachedProviders && cachedProviders.expiresAt > Date.now()) {
    return cachedProviders.value;
  }

  if (!providersRequest) {
    providersRequest = fetchExchangeProviders()
      .then(providers => {
        if (providers === null) {
          // Keep serving the last good catalog through transient outages;
          // the failure TTL only delays the next refresh attempt.
          cachedProviders = {
            value: cachedProviders?.value ?? null,
            expiresAt: Date.now() + EXCHANGE_PROVIDERS_FAILURE_TTL_MS,
          };
        } else {
          cachedProviders = {
            value: providers,
            expiresAt: Date.now() + EXCHANGE_PROVIDERS_TTL_MS,
          };
        }
        return cachedProviders.value;
      })
      .finally(() => {
        providersRequest = undefined;
      });
  }

  // Serve the stale catalog while the refresh runs in the background so
  // request latency never depends on the catalog endpoint; only the very
  // first lookup after boot has nothing to serve and waits.
  if (cachedProviders) {
    return cachedProviders.value;
  }

  return providersRequest;
}

function providerMatchesUrl(provider: ExchangeProvider, inputUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return false;
  }

  const host = normalizeHost(parsed.hostname);
  const pathname = parsed.pathname || "/";

  return provider.routes.some(route => {
    if (!route.domains.has(host)) {
      return false;
    }

    if (route.pathPrefixes.length === 0) {
      return true;
    }

    // Prefix matches respect path segment boundaries: "/person" matches
    // "/person" and "/person/x" but never "/personality".
    return route.pathPrefixes.some(prefix =>
      prefix.endsWith("/")
        ? pathname.startsWith(prefix)
        : pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
  });
}

export async function resolveExchangeProvider(
  inputUrl: string,
): Promise<ExchangeProvider | null> {
  const providers = await getExchangeProviders();
  if (providers === null) {
    return null;
  }

  return providers.find(provider => providerMatchesUrl(provider, inputUrl)) ?? null;
}

export function getExchangeRequestLogContext(inputUrl: string):
  | {
      url: string;
      host: string;
      pathPrefix: string | null;
    }
  | undefined {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return undefined;
  }

  // Never log embedded credentials from user-submitted URLs.
  parsed.username = "";
  parsed.password = "";

  return {
    url: parsed.href,
    host: parsed.hostname.toLowerCase(),
    pathPrefix:
      parsed.pathname
        .split("/")
        .map(part => part.trim())
        .filter(part => part.length > 0)[0] ?? null,
  };
}

export function getExchangeResponseLogContext(meta: unknown): {
  cacheState?: string;
  cachedAt?: string;
  cacheAgeMs?: number;
  providerRequestId?: string;
} {
  if (typeof meta !== "object" || meta === null) {
    return {};
  }

  const record = meta as Record<string, unknown>;
  const requestId = record.request_id ?? record.requestId;

  return {
    ...(typeof record.cacheState === "string"
      ? { cacheState: record.cacheState }
      : {}),
    ...(typeof record.cachedAt === "string"
      ? { cachedAt: record.cachedAt }
      : {}),
    ...(typeof record.cacheAgeMs === "number"
      ? { cacheAgeMs: record.cacheAgeMs }
      : {}),
    ...(typeof requestId === "string" ? { providerRequestId: requestId } : {}),
  };
}

export function isSuccessfulExchangeStatusCode(statusCode: number): boolean {
  return (statusCode >= 200 && statusCode < 300) || statusCode === 304;
}

export function isSupportedExchangeFormatRequest(
  formats?: FormatObject[] | unknown[],
): boolean {
  if (formats === undefined) {
    return true;
  }

  if (!Array.isArray(formats) || formats.length === 0) {
    return false;
  }

  return formats.every(format => {
    const type =
      typeof format === "string"
        ? format
        : typeof format === "object" && format !== null && "type" in format
          ? (format as { type?: unknown }).type
          : undefined;

    return typeof type === "string" && SUPPORTED_FORMATS.has(type);
  });
}

type DataSourceAccessDecision = "allowed" | "terms_required" | "not_enabled";

function getProviderAccessDecision(
  provider: ExchangeProvider,
  flags: RouteInput["flags"],
): DataSourceAccessDecision {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return "allowed";
  }

  const access = flags?.organizationDataSourceAccess?.[provider.id];
  const entry = typeof access === "object" && access !== null ? access : null;

  if (provider.terms === undefined) {
    return entry !== null && entry.status !== "enabled" ? "not_enabled" : "allowed";
  }

  if (entry === null) {
    return "terms_required";
  }

  if (entry.status !== "enabled") {
    return "not_enabled";
  }

  return entry.termsKey === provider.terms.key &&
    entry.termsVersion === provider.terms.version
    ? "allowed"
    : "terms_required";
}

function isExchangeEligibleRequest(input: RouteInput): boolean {
  if (input.flags?.[EXCHANGE_BETA_FLAG] !== true) {
    return false;
  }

  if (!config.FIRE_EXCHANGE_URL) {
    return false;
  }

  if (!input.url) {
    return false;
  }

  if (input.zeroDataRetention || input.lockdown) {
    return false;
  }

  if (Array.isArray(input.actions) && input.actions.length > 0) {
    return false;
  }

  if (input.headers && Object.keys(input.headers).length > 0) {
    return false;
  }

  if (input.waitFor !== undefined && input.waitFor !== 0) {
    return false;
  }

  if (input.mobile || input.location || input.blockAds === false) {
    return false;
  }

  // Profile-backed scrapes expect session-specific content, which the
  // Exchange cannot serve.
  if (input.profile !== undefined) {
    return false;
  }

  // atsv is only supported by browser engines; requests that set it keep an
  // engine that can honor it instead of routing to the Exchange.
  if (input.atsv === true) {
    return false;
  }

  // minAge requests ask for Firecrawl-cached data; the Exchange serves
  // provider data and Firecrawl never caches it, so the semantics cannot
  // be honored here.
  if (input.minAge !== undefined) {
    return false;
  }

  // Selector-based content filtering does not apply to provider records.
  if (
    (Array.isArray(input.includeTags) && input.includeTags.length > 0) ||
    (Array.isArray(input.excludeTags) && input.excludeTags.length > 0)
  ) {
    return false;
  }

  if (input.proxy === "stealth" || input.proxy === "enhanced") {
    return false;
  }

  if (!isSupportedExchangeFormatRequest(input.formats)) {
    return false;
  }

  return true;
}

export type ExchangeAccess =
  | {
      allowed: true;
      termsRequired: false;
      provider: ExchangeProvider;
    }
  | {
      allowed: false;
      termsRequired: true;
      terms: ExchangeTerms;
    }
  | {
      allowed: false;
      termsRequired: false;
    };

export async function getExchangeAccessForRequest(
  input: RouteInput,
): Promise<ExchangeAccess> {
  // The Exchange gate sits on the hot path of every scrape request; no
  // failure inside it may ever fail the request itself. Anything unexpected
  // degrades to "not eligible" and the request continues on the normal path.
  try {
    if (!isExchangeEligibleRequest(input)) {
      return { allowed: false, termsRequired: false };
    }

    const provider = await resolveExchangeProvider(input.url);
    if (provider === null) {
      return { allowed: false, termsRequired: false };
    }

    const decision = getProviderAccessDecision(provider, input.flags);
    if (decision === "terms_required" && provider.terms !== undefined) {
      return { allowed: false, termsRequired: true, terms: provider.terms };
    }
    if (decision !== "allowed") {
      return { allowed: false, termsRequired: false };
    }

    return { allowed: true, termsRequired: false, provider };
  } catch (error) {
    rootLogger.warn("Exchange access check errored; treating as ineligible", {
      error,
    });
    return { allowed: false, termsRequired: false };
  }
}

export async function canUseExchangeForRequest(
  input: RouteInput,
): Promise<boolean> {
  return (await getExchangeAccessForRequest(input)).allowed;
}

function getThirdPartyDataTermsSettingsUrl(): string {
  return `${config.FIRECRAWL_DASHBOARD_URL.replace(/\/+$/, "")}/app/settings?tab=data-sources`;
}

export function getThirdPartyDataTermsRequiredResponse(terms: ExchangeTerms) {
  return {
    success: false as const,
    code: THIRD_PARTY_DATA_TERMS_REQUIRED_CODE as "THIRD_PARTY_DATA_TERMS_REQUIRED",
    error: THIRD_PARTY_DATA_TERMS_REQUIRED_MESSAGE,
    requiresAction: {
      type: "accept_terms",
      terms: terms.key,
      version: terms.version,
      url: getThirdPartyDataTermsSettingsUrl(),
    },
  };
}

export function getExchangeSuccessCredits(input: {
  exchange?: ExchangeScrapeMetadata;
  statusCode?: number | null;
}): number | null {
  if (input.exchange?.handled !== true) {
    return null;
  }

  const statusCode = input.statusCode;
  if (
    statusCode === undefined ||
    statusCode === null ||
    !isSuccessfulExchangeStatusCode(statusCode)
  ) {
    return null;
  }

  return input.exchange.creditsCost;
}

const EXCHANGE_BILLING_TIMEOUT_MS = 5_000;
const EXCHANGE_BILLING_ATTEMPTS = 3;
const EXCHANGE_BILLING_RETRY_DELAY_MS = 2_000;
const EXCHANGE_BILLING_RETRY_MAX_DELAY_MS = 15_000;

// Retry-After from a 429, in milliseconds, when present and sane.
// Accepts both delta-seconds and HTTP-date forms.
function getRetryAfterMs(response: {
  headers?: { get?: (name: string) => string | null };
}): number | undefined {
  const header = response.headers?.get?.("retry-after");
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? seconds * 1_000 : undefined;
  }

  const resetAt = Date.parse(header);
  if (Number.isNaN(resetAt)) {
    return undefined;
  }
  const delayMs = resetAt - Date.now();
  return delayMs > 0 ? delayMs : undefined;
}

/**
 * Report the billing outcome of a delivered Exchange access so the service
 * can reconcile its ledger: "confirmed" once the customer was billed, "void"
 * when the delivered access was ultimately discarded and never billed.
 * Retries transient failures with a short backoff; never throws. Returns
 * whether the report was accepted - a sustained failure leaves the event
 * pending on the Exchange, which flags unresolved events for follow-up.
 */
export async function reportExchangeBilling(input: {
  accessEventId: string;
  status: "confirmed" | "void";
  billingReference?: string;
}): Promise<boolean> {
  const baseUrl = getExchangeBaseUrl();
  if (!baseUrl) {
    return false;
  }

  for (let attempt = 1; attempt <= EXCHANGE_BILLING_ATTEMPTS; attempt++) {
    let retryAfterMs: number | undefined;

    try {
      const response = await fetch(
        `${baseUrl}/v1/access-events/${encodeURIComponent(input.accessEventId)}/billing`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: input.status,
            ...(input.billingReference === undefined
              ? {}
              : { billingReference: input.billingReference }),
          }),
          signal: AbortSignal.timeout(EXCHANGE_BILLING_TIMEOUT_MS),
        },
      );

      if (response.ok) {
        return true;
      }

      // 4xx responses other than 429 are definitive (conflict, unknown
      // event) - the Exchange has spoken and a retry cannot change the
      // answer. 429 is transient rate limiting and retries.
      if (response.status < 500 && response.status !== 429) {
        rootLogger.warn("Exchange billing report rejected", {
          accessEventId: input.accessEventId,
          status: input.status,
          statusCode: response.status,
        });
        return false;
      }

      if (response.status === 429) {
        retryAfterMs = getRetryAfterMs(response);
      }

      rootLogger.warn("Exchange billing report failed", {
        accessEventId: input.accessEventId,
        status: input.status,
        statusCode: response.status,
        attempt,
      });
    } catch (error) {
      rootLogger.warn("Exchange billing report errored", {
        accessEventId: input.accessEventId,
        status: input.status,
        attempt,
        error,
      });
    }

    if (attempt < EXCHANGE_BILLING_ATTEMPTS) {
      // Full jitter on the backoff so a batch of reports failing together
      // does not retry against a degraded Exchange in synchronized bursts.
      // Retry-After, when given, is the lower bound.
      const backoff = EXCHANGE_BILLING_RETRY_DELAY_MS * attempt;
      const delay = Math.min(
        Math.max(retryAfterMs ?? 0, Math.random() * backoff),
        EXCHANGE_BILLING_RETRY_MAX_DELAY_MS,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return false;
}

/**
 * Warm the provider catalog at process startup so the first flagged-org
 * request never waits on the fetch; after this, stale-while-revalidate
 * keeps every lookup in-memory. No-op when the Exchange is not configured;
 * never throws.
 */
export function warmExchangeCatalog(): void {
  if (!config.FIRE_EXCHANGE_URL) {
    return;
  }

  void getExchangeProviders();
}

export function setExchangeProvidersForTest(
  providers: {
    id: string;
    creditsCost?: number;
    terms?: ExchangeTerms;
    routes: { domains: string[]; pathPrefixes?: string[] }[];
  }[],
  ttlMs = 300_000,
) {
  cachedProviders = {
    value: providers.map(provider => ({
      id: provider.id,
      creditsCost: provider.creditsCost ?? 0,
      ...(provider.terms === undefined ? {} : { terms: provider.terms }),
      routes: provider.routes.map(route => ({
        domains: new Set(route.domains.map(normalizeHost)),
        pathPrefixes: (route.pathPrefixes ?? []).map(normalizePathPrefix),
      })),
    })),
    expiresAt: Date.now() + ttlMs,
  };
}

export function clearExchangeProvidersForTest() {
  cachedProviders = undefined;
  providersRequest = undefined;
}
