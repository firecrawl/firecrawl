import { createHash } from "crypto";
import { ProxyAgent, type Dispatcher } from "undici";
import { config } from "../../../../config";

// Minimal Zscaler OneAPI client for the ZIA endpoints the "zscaler" threat
// protection mode needs: OAuth2 client-credentials tokens from Zidentity,
// GET /urlCategories (taxonomy + custom-list sync), and POST /urlLookup
// (inline classification). All traffic goes through the partner egress proxy
// (PARTNER_EGRESS_PROXY_URL) when configured, so the customer only has to
// allowlist our published static IP.
//
// Tokens are cached in memory only — never in Redis or Postgres. The lookup
// batcher and the sync path are the only sustained callers, and both run
// behind per-org distributed locks, so at any moment only a handful of
// processes hold a token. Zscaler supports two active client secrets, which
// makes rotation zero-downtime: verdicts keep flowing on the old secret's
// tokens until the new secret is saved here.

export interface ZscalerCredentials {
  clientId: string;
  clientSecret: string;
  /** Zidentity vanity domain: tokens come from https://<vanityDomain>.zslogin.net */
  vanityDomain: string;
  /** OneAPI cloud name (api.<cloud>.zsapi.net); null = default (api.zsapi.net). */
  cloud: string | null;
}

type ZscalerErrorKind =
  /** Token endpoint rejected the client (bad ID/secret, revoked client). */
  | "auth"
  /** Authenticated, but the role/scope does not allow the resource (403). */
  | "scope"
  /** 429 from the API — the tenant-side rate limit, not our local budget. */
  | "rate-limit"
  /** Our own per-org hourly budget is exhausted (no API call was made). */
  | "quota"
  /** Anything else: transport failures, 5xx, malformed responses. */
  | "api";

export class ZscalerError extends Error {
  constructor(
    public readonly kind: ZscalerErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ZscalerError";
  }
}

export interface ZscalerUrlLookupResult {
  url: string;
  urlClassifications: string[];
  urlClassificationsWithSecurityAlert: string[];
}

/**
 * One entry of GET /urlCategories. Field names follow the ZIA API (see the
 * official zscaler-sdk-go/py `urlcategories` services): custom categories
 * carry `urls`/`keywords`, and `dbCategorizedUrls` /
 * `keywordsRetainingParentCategory` hold the "retaining parent category"
 * variants (the URL/keyword keeps its Zscaler-defined classification AND
 * gains the custom category).
 */
export interface ZscalerUrlCategory {
  id: string;
  configuredName?: string;
  customCategory?: boolean;
  urls?: string[];
  dbCategorizedUrls?: string[];
  keywords?: string[];
  keywordsRetainingParentCategory?: string[];
}

const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MAX_TOKEN_CACHE_ENTRIES = 100;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
let proxyDispatcher: ProxyAgent | undefined;
let proxyDispatcherUrl: string | undefined;

function getDispatcher(): Dispatcher | undefined {
  if (!config.PARTNER_EGRESS_PROXY_URL) return undefined;
  if (
    !proxyDispatcher ||
    proxyDispatcherUrl !== config.PARTNER_EGRESS_PROXY_URL
  ) {
    proxyDispatcher = new ProxyAgent(config.PARTNER_EGRESS_PROXY_URL);
    proxyDispatcherUrl = config.PARTNER_EGRESS_PROXY_URL;
  }
  return proxyDispatcher;
}

function tokenUrl(credentials: ZscalerCredentials): string {
  return (
    config.ZSCALER_TOKEN_URL_OVERRIDE ??
    `https://${credentials.vanityDomain}.zslogin.net/oauth2/v1/token`
  );
}

function apiBaseUrl(credentials: ZscalerCredentials): string {
  const base =
    config.ZSCALER_API_URL_OVERRIDE ??
    (credentials.cloud
      ? `https://api.${credentials.cloud}.zsapi.net`
      : "https://api.zsapi.net");
  return `${base.replace(/\/+$/, "")}/zia/api/v1`;
}

function tokenCacheKey(credentials: ZscalerCredentials): string {
  const secretDigest = createHash("sha256")
    .update(credentials.clientSecret)
    .digest("base64url");
  return `${credentials.vanityDomain}:${credentials.clientId}:${secretDigest}`;
}

function cacheToken(cacheKey: string, token: CachedToken): void {
  const now = Date.now();
  for (const [key, cached] of tokenCache) {
    if (cached.expiresAt <= now) tokenCache.delete(key);
  }
  tokenCache.delete(cacheKey);
  while (tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey === undefined) break;
    tokenCache.delete(oldestKey);
  }
  tokenCache.set(cacheKey, token);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

// Error responses must have their bodies consumed, or undici cannot reuse
// the connection and sockets pile up under repeated failures.
function drainBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

async function fetchAccessToken(
  credentials: ZscalerCredentials,
  signal: AbortSignal | undefined,
): Promise<string> {
  const cacheKey = tokenCacheKey(credentials);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    audience: "https://api.zscaler.com",
  });

  let response: Response;
  try {
    response = await fetch(tokenUrl(credentials), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
      // undici extension: route through the partner egress proxy.
      dispatcher: getDispatcher(),
    } as RequestInit);
  } catch (error) {
    throw new ZscalerError(
      "api",
      `Failed to reach the Zscaler token endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 400 || response.status === 401) {
    drainBody(response);
    throw new ZscalerError(
      "auth",
      "Zscaler rejected the OAuth client credentials",
      response.status,
    );
  }
  if (response.status === 429) {
    drainBody(response);
    throw new ZscalerError(
      "rate-limit",
      "Zscaler token endpoint rate limit hit",
      response.status,
      retryAfterMs(response),
    );
  }
  if (!response.ok) {
    drainBody(response);
    throw new ZscalerError(
      "api",
      `Zscaler token endpoint returned status ${response.status}`,
      response.status,
    );
  }

  let payload: { access_token?: string; expires_in?: number };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new ZscalerError("api", "Zscaler token response was not JSON");
  }
  if (!payload.access_token) {
    throw new ZscalerError("api", "Zscaler token response had no access_token");
  }

  const expiresInMs =
    (typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in * 1000
      : 3600_000) - TOKEN_EXPIRY_SKEW_MS;
  cacheToken(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(expiresInMs, 10_000),
  });
  return payload.access_token;
}

async function apiRequest<T>(
  credentials: ZscalerCredentials,
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  let token = await fetchAccessToken(credentials, signal);

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl(credentials)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
        dispatcher: getDispatcher(),
      } as RequestInit);
    } catch (error) {
      throw new ZscalerError(
        "api",
        `Failed to reach the Zscaler API: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 401 && attempt === 1) {
      // Token expired or was revoked mid-flight: drop it and retry once with
      // a fresh one. A second 401 is a real auth problem.
      drainBody(response);
      tokenCache.delete(tokenCacheKey(credentials));
      token = await fetchAccessToken(credentials, signal);
      continue;
    }
    if (response.status === 401) {
      drainBody(response);
      throw new ZscalerError(
        "auth",
        "Zscaler API rejected the access token",
        response.status,
      );
    }
    if (response.status === 403) {
      drainBody(response);
      throw new ZscalerError(
        "scope",
        `Zscaler API denied access to ${path} — the API client's role does not cover it`,
        response.status,
      );
    }
    if (response.status === 429) {
      drainBody(response);
      throw new ZscalerError(
        "rate-limit",
        `Zscaler API rate limit hit on ${path}`,
        response.status,
        retryAfterMs(response),
      );
    }
    if (!response.ok) {
      drainBody(response);
      throw new ZscalerError(
        "api",
        `Zscaler API returned status ${response.status} for ${path}`,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ZscalerError(
        "api",
        `Zscaler API response for ${path} was not JSON`,
      );
    }
  }
}

/** ZIA rejects lookup entries longer than this. */
const MAX_LOOKUP_URL_LENGTH = 1024;

/**
 * Shape a URL the way POST /urlLookup expects: no scheme, no fragment,
 * lowercased host. Accepts anything checkUrl's canonicalizer produces.
 * URLs over the ZIA length limit throw (a truncated URL would classify a
 * DIFFERENT URL); the caller resolves that through the failurePolicy.
 */
export function toLookupUrl(url: string): string {
  let value = url.trim();
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const hash = value.indexOf("#");
  if (hash !== -1) value = value.slice(0, hash);
  const slash = value.indexOf("/");
  const host = (slash === -1 ? value : value.slice(0, slash)).toLowerCase();
  const rest = slash === -1 ? "" : value.slice(slash);
  // A bare host needs no trailing slash; strip one so "example.com/" and
  // "example.com" share a verdict key.
  const combined = `${host}${rest === "/" ? "" : rest}`;
  if (combined.length > MAX_LOOKUP_URL_LENGTH) {
    throw new ZscalerError(
      "api",
      `URL exceeds the ${MAX_LOOKUP_URL_LENGTH}-character ZIA lookup limit`,
    );
  }
  return combined;
}

/**
 * Classify up to 100 URLs. Returns one entry per distinct URL; entries the
 * tenant has not categorized come back with `MISCELLANEOUS_OR_UNKNOWN`.
 * NOTE (ZIA behavior): custom URL classifications are NOT returned by this
 * endpoint — custom-list decisions come from the synced local rules instead.
 */
export async function zscalerLookupUrls(
  credentials: ZscalerCredentials,
  urls: string[],
  options?: { signal?: AbortSignal },
): Promise<ZscalerUrlLookupResult[]> {
  if (urls.length === 0) return [];
  if (urls.length > 100) {
    throw new ZscalerError("api", "urlLookup accepts at most 100 URLs");
  }
  const results = await apiRequest<
    Array<{
      url?: string;
      urlClassifications?: string[];
      urlClassificationsWithSecurityAlert?: string[];
    }>
  >(credentials, "POST", "/urlLookup", urls, options?.signal);
  if (!Array.isArray(results)) {
    throw new ZscalerError("api", "urlLookup response was not an array");
  }
  return results.map(entry => ({
    url: entry.url ?? "",
    urlClassifications: Array.isArray(entry.urlClassifications)
      ? entry.urlClassifications.filter(c => typeof c === "string")
      : [],
    urlClassificationsWithSecurityAlert: Array.isArray(
      entry.urlClassificationsWithSecurityAlert,
    )
      ? entry.urlClassificationsWithSecurityAlert.filter(
          c => typeof c === "string",
        )
      : [],
  }));
}

/**
 * Fetch the tenant's full category taxonomy: Zscaler-defined categories,
 * custom categories with their URL lists and keywords, and customer
 * additions to Zscaler-defined categories (`dbCategorizedUrls`).
 */
export async function zscalerGetUrlCategories(
  credentials: ZscalerCredentials,
  options?: { signal?: AbortSignal },
): Promise<ZscalerUrlCategory[]> {
  const results = await apiRequest<ZscalerUrlCategory[]>(
    credentials,
    "GET",
    "/urlCategories",
    undefined,
    options?.signal,
  );
  if (!Array.isArray(results)) {
    throw new ZscalerError("api", "urlCategories response was not an array");
  }
  return results.filter(
    entry => entry && typeof entry === "object" && typeof entry.id === "string",
  );
}

interface ZscalerConnectionTestResult {
  ok: boolean;
  /** Token endpoint accepted the client credentials. */
  tokenOk: boolean;
  /** GET /urlCategories succeeded (taxonomy readable). */
  categoriesOk: boolean;
  /** POST /urlLookup succeeded (inline classification permitted). */
  lookupOk: boolean;
  categoryCount: number | null;
  /** Set when ok is false: which stage failed and why. */
  error: { kind: ZscalerErrorKind; message: string } | null;
}

/**
 * Three-stage connection test: token (distinguishes bad credentials),
 * taxonomy read, and a lookup probe (a View Only role can read the taxonomy
 * but may be refused the read-semantic POST /urlLookup — surfacing that here
 * beats surfacing it on the first scrape).
 *
 * The optional stage hooks run immediately before their API call and abort
 * the stage by throwing — the caller charges its shared tenant budgets there,
 * so a test that dies at an earlier stage never spends points for calls that
 * were never made.
 */
export async function zscalerTestConnection(
  credentials: ZscalerCredentials,
  options?: {
    signal?: AbortSignal;
    beforeCategories?: () => Promise<void>;
    beforeLookup?: () => Promise<void>;
  },
): Promise<ZscalerConnectionTestResult> {
  const result: ZscalerConnectionTestResult = {
    ok: false,
    tokenOk: false,
    categoriesOk: false,
    lookupOk: false,
    categoryCount: null,
    error: null,
  };

  const fail = (error: unknown): ZscalerConnectionTestResult => {
    const zscalerError =
      error instanceof ZscalerError
        ? error
        : new ZscalerError(
            "api",
            error instanceof Error ? error.message : String(error),
          );
    result.error = { kind: zscalerError.kind, message: zscalerError.message };
    return result;
  };

  try {
    await fetchAccessToken(credentials, options?.signal);
    result.tokenOk = true;
  } catch (error) {
    return fail(error);
  }

  try {
    await options?.beforeCategories?.();
    const categories = await zscalerGetUrlCategories(credentials, options);
    result.categoriesOk = true;
    result.categoryCount = categories.length;
  } catch (error) {
    return fail(error);
  }

  try {
    await options?.beforeLookup?.();
    await zscalerLookupUrls(credentials, ["example.com"], options);
    result.lookupOk = true;
  } catch (error) {
    return fail(error);
  }

  result.ok = true;
  return result;
}
