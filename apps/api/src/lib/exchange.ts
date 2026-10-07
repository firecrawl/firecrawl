import { fetch } from "undici";
import { z } from "zod";

import { config } from "../config";
import type { DocumentProvider, FormatObject } from "../controllers/v2/types";
import { hasLedgerAcceptance } from "../services/alexandria/terms";
import { type ErrorCodes, TransportableError } from "./error";
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
  teamId?: string | null;
  orgId?: string | null;
  /** The URL is on the team's blocklist, so the Exchange is the only way to serve it. */
  blocked?: boolean;
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
  redactPII?: unknown;
  flags?: {
    professionalProfileCompanyDataBeta?: boolean;
    organizationDataSourceAccess?: OrganizationDataSourceAccess | null;
  } | null;
};

export type ExchangeScrapeMetadata = {
  accessEventId?: string;
  provider: DocumentProvider;
};

type ExchangeTerms = {
  key: string;
  version: string;
};

type ExchangeProvider = {
  id: string;
  creditsCost: number;
  terms?: ExchangeTerms;
  routes: {
    domains: Set<string>;
    pathPrefixes: string[];
  }[];
};

// Formats the regular transformers derive from the Exchange's markdown (and the
// HTML rendered from it). deterministicJson, screenshots and the like need the
// real page, which the Exchange never fetches.
const SUPPORTED_FORMATS = new Set([
  "markdown",
  "html",
  "rawHtml",
  "links",
  "images",
  "json",
  "summary",
  "question",
  "highlights",
  "query",
]);
const EXCHANGE_BETA_FLAG = "professionalProfileCompanyDataBeta";

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

function providerMatchesUrl(
  provider: ExchangeProvider,
  inputUrl: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return false;
  }

  const host = normalizeHost(parsed.hostname);
  const pathname = parsed.pathname || "/";
  // "*.example.com" claims every subdomain of example.com, never the apex.
  const wildcards = [...host.matchAll(/\./g)].map(
    dot => `*${host.slice(dot.index)}`,
  );

  return provider.routes.some(route => {
    if (
      !route.domains.has(host) &&
      !wildcards.some(wildcard => route.domains.has(wildcard))
    ) {
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

// Organizations kept on the direct FullEnrich path for LinkedIn, which predates
// enrichment preferences: they skip the enrichment provider and resolve to the
// next claimant in the catalog.
const ENRICHMENT_PROVIDER_ID = "firecrawl-enrich";
const LEGACY_FULLENRICH_ORGS = new Set([
  "34a599c6-e6c2-4e6f-b563-0e23bb2552c1",
  "adcef175-be20-4534-96ad-fcd413e3c457",
  "2567598d-d959-44d3-8c4a-19fd467ec66d",
  "709cf0a7-7769-4c7e-a5e1-ad44f38f9c36",
]);

export async function resolveExchangeProvider(
  inputUrl: string,
  orgId?: string | null,
): Promise<ExchangeProvider | null> {
  const providers = await getExchangeProviders();
  if (providers === null) {
    return null;
  }

  const skipEnrichment = orgId != null && LEGACY_FULLENRICH_ORGS.has(orgId);
  return (
    providers.find(
      provider =>
        !(skipEnrichment && provider.id === ENRICHMENT_PROVIDER_ID) &&
        providerMatchesUrl(provider, inputUrl),
    ) ?? null
  );
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

/** Names the first requested format the Exchange can't serve, or null when it serves them all. */
export function getUnsupportedExchangeFormat(
  formats?: FormatObject[] | unknown[],
): string | null {
  if (formats === undefined) {
    return null;
  }

  if (!Array.isArray(formats) || formats.length === 0) {
    return "`formats`";
  }

  for (const format of formats) {
    const type =
      typeof format === "string"
        ? format
        : typeof format === "object" && format !== null && "type" in format
          ? (format as { type?: unknown }).type
          : undefined;

    if (typeof type !== "string" || !SUPPORTED_FORMATS.has(type)) {
      return typeof type === "string" ? `the \`${type}\` format` : "`formats`";
    }
  }

  return null;
}

type DataSourceAccessDecision = "allowed" | "terms_required" | "not_enabled";

const LEDGER_ACCEPTANCE_TIMEOUT_MS = 2_000;
const LEDGER_ACCEPTED_TTL_MS = 60_000;
const LEDGER_NOT_ACCEPTED_TTL_MS = 10_000;
const LEDGER_ACCEPTANCE_CACHE_MAX_ENTRIES = 10_000;

const ledgerAcceptanceCache = new Map<
  string,
  { expiresAt: number; value: Promise<boolean> }
>();

// The ledger lookup costs two Exchange calls and sits on the scrape path, so
// answers are cached per process: briefly when not accepted, so a fresh
// acceptance is picked up quickly, and longer once accepted. Keyed by the
// team the Exchange calls are made for and the catalog's terms identity, so
// new terms are rechecked as soon as the catalog carries them.
function getLedgerAcceptance(input: {
  teamId: string;
  orgId: string;
  provider: string;
  terms: ExchangeTerms;
  revocation?: { disabledAt: unknown };
}): Promise<boolean> {
  const key = [
    input.teamId,
    input.orgId,
    input.provider,
    input.terms.key,
    input.terms.version,
    input.revocation === undefined ? "" : String(input.revocation.disabledAt),
  ].join("\0");
  const cached = ledgerAcceptanceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (ledgerAcceptanceCache.size >= LEDGER_ACCEPTANCE_CACHE_MAX_ENTRIES) {
    ledgerAcceptanceCache.clear();
  }

  const entry = {
    expiresAt: Date.now() + LEDGER_NOT_ACCEPTED_TTL_MS,
    value: Promise.resolve(false),
  };
  entry.value = hasLedgerAcceptance({
    teamId: input.teamId,
    orgId: input.orgId,
    provider: input.provider,
    revocation: input.revocation,
    timeoutMs: LEDGER_ACCEPTANCE_TIMEOUT_MS,
  })
    .catch(() => false)
    .then(accepted => {
      if (accepted) {
        entry.expiresAt = Date.now() + LEDGER_ACCEPTED_TTL_MS;
      }
      return accepted;
    });
  ledgerAcceptanceCache.set(key, entry);
  return entry.value;
}

// Mirrors authorizeProviders (services/alexandria/access.ts), so a provider
// is reachable through Scrape exactly when it is through Alexandria: the
// organizationDataSourceAccess flags first, then the Exchange ledger, where
// the API's accept route records acceptance.
async function getProviderAccessDecision(
  provider: ExchangeProvider,
  input: RouteInput,
): Promise<DataSourceAccessDecision> {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return "allowed";
  }

  const access = input.flags?.organizationDataSourceAccess?.[provider.id];
  const entry = typeof access === "object" && access !== null ? access : null;

  if (provider.terms === undefined) {
    return entry !== null && entry.status !== "enabled"
      ? "not_enabled"
      : "allowed";
  }

  const teamId = input.teamId ?? null;
  const orgId = input.orgId ?? null;

  if (entry !== null && entry.status !== "enabled") {
    // An admin revocation is lifted by a ledger acceptance recorded after
    // it; until then the provider asks for its terms again.
    const revokedByAdmin =
      entry.status === "disabled" &&
      entry.disabledReason === "revoked_by_organization_admin";
    if (!revokedByAdmin || teamId === null || orgId === null) {
      return "not_enabled";
    }

    return (await getLedgerAcceptance({
      teamId,
      orgId,
      provider: provider.id,
      terms: provider.terms,
      revocation: { disabledAt: entry.disabledAt },
    }))
      ? "allowed"
      : "terms_required";
  }

  if (
    entry !== null &&
    entry.termsKey === provider.terms.key &&
    entry.termsVersion === provider.terms.version
  ) {
    return "allowed";
  }

  if (
    teamId !== null &&
    orgId !== null &&
    (await getLedgerAcceptance({
      teamId,
      orgId,
      provider: provider.id,
      terms: provider.terms,
    }))
  ) {
    return "allowed";
  }

  return "terms_required";
}

function isExchangeEligibleRequest(input: RouteInput): boolean {
  // Blocked URLs go to the Exchange for every team, since nothing else may
  // serve them; elsewhere it replaces a normal scrape only for the beta.
  if (input.flags?.[EXCHANGE_BETA_FLAG] !== true && input.blocked !== true) {
    return false;
  }

  return !!config.FIRE_EXCHANGE_URL && !!input.url;
}

/** Names the request option that keeps the Exchange from serving the URL, or null when there is none. */
function getUnsupportedExchangeOption(input: RouteInput): string | null {
  // Named in plain words: a team policy can force it as well as the request.
  if (input.zeroDataRetention) {
    return "zero data retention";
  }

  if (input.lockdown) {
    return "`lockdown`";
  }

  if (Array.isArray(input.actions) && input.actions.length > 0) {
    return "`actions`";
  }

  // Profile-backed scrapes expect session-specific content, which the
  // Exchange cannot serve.
  if (input.profile !== undefined) {
    return "`profile`";
  }

  // PII redaction works on page text; on a provider record it would miss the
  // person's name in URLs and handles while still charging for it.
  if (input.redactPII) {
    return "`redactPII`";
  }

  // Rendering options only mean something for a real page. A blocked URL has
  // no page Firecrawl may render, so they are ignored there; anywhere else a
  // request that sets them keeps the normal engines.
  if (input.blocked !== true) {
    const rendering = Object.entries({
      headers:
        input.headers !== undefined && Object.keys(input.headers).length > 0,
      waitFor: input.waitFor !== undefined && input.waitFor !== 0,
      mobile: !!input.mobile,
      location: !!input.location,
      blockAds: input.blockAds === false,
      atsv: input.atsv === true,
      proxy: input.proxy === "stealth" || input.proxy === "enhanced",
      includeTags:
        Array.isArray(input.includeTags) && input.includeTags.length > 0,
      excludeTags:
        Array.isArray(input.excludeTags) && input.excludeTags.length > 0,
    }).find(([, set]) => set);
    if (rendering) {
      return `\`${rendering[0]}\``;
    }
  }

  // minAge requests ask for Firecrawl-cached data; the Exchange serves
  // provider data and Firecrawl never caches it, so the semantics cannot
  // be honored here.
  if (input.minAge !== undefined) {
    return "`minAge`";
  }

  return getUnsupportedExchangeFormat(input.formats);
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
      /** Set when a provider serves the URL but this request option keeps it out. */
      unsupportedOption?: string;
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

    const provider = await resolveExchangeProvider(input.url, input.orgId);
    if (provider === null) {
      return { allowed: false, termsRequired: false };
    }

    const unsupportedOption = getUnsupportedExchangeOption(input);
    if (unsupportedOption !== null) {
      return { allowed: false, termsRequired: false, unsupportedOption };
    }

    const decision = await getProviderAccessDecision(provider, input);
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

// Terms are keyed by provider id, so the key doubles as the provider page to accept them on.
function getThirdPartyDataTermsUrl(terms: ExchangeTerms): string {
  return `${config.FIRECRAWL_DASHBOARD_URL.replace(/\/+$/, "")}/app/alexandria/${encodeURIComponent(terms.key)}`;
}

export function getEnrichmentSettingsUrl(): string {
  return `${config.FIRECRAWL_DASHBOARD_URL.replace(/\/+$/, "")}/app/alexandria?enrichment=true`;
}

/**
 * An organization admin has to accept a provider's terms before the request
 * can run. Transportable, so it crosses the worker queue intact; every
 * surface that reports it sends `response()`, or `requiresAction` alone where
 * the error is one entry of a list.
 */
export class ThirdPartyDataTermsRequiredError extends TransportableError {
  public readonly terms: ExchangeTerms;
  /** Set when the provider is a step in the team's enrichment order, which can drop it instead. */
  public readonly enrichment: boolean;

  constructor(terms: ExchangeTerms, options: { enrichment?: boolean } = {}) {
    const accept = `An organization admin must accept the ${terms.key} provider's terms (version ${terms.version}) before this request can run. Accept them at ${getThirdPartyDataTermsUrl(terms)}`;
    super(
      "THIRD_PARTY_DATA_TERMS_REQUIRED",
      options.enrichment
        ? `${accept}, or turn off ${terms.key} in ${getEnrichmentSettingsUrl()}.`
        : accept,
    );
    this.name = "ThirdPartyDataTermsRequiredError";
    this.terms = { key: terms.key, version: terms.version };
    this.enrichment = options.enrichment === true;
  }

  get requiresAction() {
    return {
      type: "accept_terms" as const,
      terms: this.terms.key,
      version: this.terms.version,
      url: getThirdPartyDataTermsUrl(this.terms),
    };
  }

  response() {
    return {
      success: false as const,
      code: "THIRD_PARTY_DATA_TERMS_REQUIRED" as const,
      error: this.message,
      requiresAction: this.requiresAction,
    };
  }

  serialize() {
    return {
      ...super.serialize(),
      terms: this.terms,
      enrichment: this.enrichment,
    };
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ThirdPartyDataTermsRequiredError(data.terms, {
      enrichment: data.enrichment,
    });
    x.stack = data.stack;
    return x;
  }
}

/**
 * A provider serves the URL and nothing else may, but the request uses an
 * option the provider's data can't honor.
 */
export class ThirdPartyDataUnsupportedOptionError extends TransportableError {
  public readonly option: string;

  constructor(option: string) {
    super(
      "THIRD_PARTY_DATA_UNSUPPORTED_OPTION",
      `A third-party data provider serves this URL, but not to requests that use ${option}.`,
    );
    this.name = "ThirdPartyDataUnsupportedOptionError";
    this.option = option;
  }

  response() {
    return {
      success: false as const,
      code: "THIRD_PARTY_DATA_UNSUPPORTED_OPTION" as const,
      error: this.message,
    };
  }

  serialize() {
    return {
      ...super.serialize(),
      option: this.option,
    };
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ThirdPartyDataUnsupportedOptionError(data.option);
    x.stack = data.stack;
    return x;
  }
}

export function getExchangeSuccessCredits(input: {
  exchange?: ExchangeScrapeMetadata;
  statusCode?: number | null;
}): number | null {
  if (input.exchange === undefined) {
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

  return input.exchange.provider.creditsCost;
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

  return deliverBillingReport({
    url: `${baseUrl}/v1/access-events/${encodeURIComponent(input.accessEventId)}/billing`,
    headers: { "Content-Type": "application/json" },
    body: {
      status: input.status,
      ...(input.billingReference === undefined
        ? {}
        : { billingReference: input.billingReference }),
    },
    retryNotFound: false,
    context: { accessEventId: input.accessEventId, status: input.status },
  });
}

/**
 * Report the billing outcome of a tool execution's usage rows, keyed by the
 * `x-request-id` sent with `/v1/retrieve`. Internal-secret route; usage is
 * recorded asynchronously on the Exchange, so a 404 is retried like a 5xx.
 */
export async function reportExchangeUsageBilling(input: {
  requestId: string;
  status: "confirmed" | "void";
  billingReference?: string;
}): Promise<boolean> {
  const baseUrl = getExchangeBaseUrl();
  if (!baseUrl || !config.EXCHANGE_INTERNAL_SECRET) {
    return false;
  }

  return deliverBillingReport({
    url: `${baseUrl}/v1/usage-events/billing`,
    headers: {
      "Content-Type": "application/json",
      "x-exchange-secret": config.EXCHANGE_INTERNAL_SECRET,
    },
    body: [
      {
        requestId: input.requestId,
        status: input.status,
        ...(input.billingReference === undefined
          ? {}
          : { billingReference: input.billingReference }),
      },
    ],
    retryNotFound: true,
    context: { requestId: input.requestId, status: input.status },
  });
}

async function deliverBillingReport(input: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  retryNotFound: boolean;
  context: Record<string, unknown>;
}): Promise<boolean> {
  for (let attempt = 1; attempt <= EXCHANGE_BILLING_ATTEMPTS; attempt++) {
    let retryAfterMs: number | undefined;

    try {
      const response = await fetch(input.url, {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(EXCHANGE_BILLING_TIMEOUT_MS),
      });

      if (response.ok) {
        return true;
      }

      // 4xx responses other than 429 are definitive (conflict, unknown
      // event) - the Exchange has spoken and a retry cannot change the
      // answer. 429 is transient rate limiting and retries, as does a 404
      // where the caller knows the rows are written asynchronously.
      if (
        response.status < 500 &&
        response.status !== 429 &&
        !(input.retryNotFound && response.status === 404)
      ) {
        rootLogger.warn("Exchange billing report rejected", {
          ...input.context,
          statusCode: response.status,
        });
        return false;
      }

      if (response.status === 429) {
        retryAfterMs = getRetryAfterMs(response);
      }

      rootLogger.warn("Exchange billing report failed", {
        ...input.context,
        statusCode: response.status,
        attempt,
      });
    } catch (error) {
      rootLogger.warn("Exchange billing report errored", {
        ...input.context,
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
  ledgerAcceptanceCache.clear();
}
