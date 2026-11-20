import { eq } from "drizzle-orm";
import { dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { deleteKey, getValue, setValue } from "../services/redis";
import { logger } from "./logger";
import type { AuthCreditUsageChunk } from "../controllers/v1/types";

// Propagation delay for dashboard edits to key_restriction_config.
const CONFIG_CACHE_TTL_SECONDS = 60;

const MANAGE_RESTRICTIONS_URL = "https://www.firecrawl.dev/app/api-keys";

const configCacheKey = (apiKeyId: number) => `key-restriction:${apiKeyId}`;

export type KeyRestrictionConfig = {
  allowedFormats: string[];
  allowedEndpoints: string[];
};

function isKeyRestricted(config: KeyRestrictionConfig): boolean {
  return config.allowedFormats.length > 0 || config.allowedEndpoints.length > 0;
}

// Invalidates the cached config so dashboard edits apply immediately
// (admin route key-restriction-cache-clear).
export async function clearKeyRestrictionCache(
  apiKeyId: number,
): Promise<void> {
  await deleteKey(configCacheKey(apiKeyId));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(x => typeof x === "string");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : [];
}

async function getKeyRestrictionConfig(
  apiKeyId: number,
): Promise<KeyRestrictionConfig> {
  const cacheKey = configCacheKey(apiKeyId);

  try {
    const cached = await getValue(cacheKey);
    if (cached !== null) {
      const parsed = JSON.parse(cached);
      // A corrupted-but-parseable cache entry must not reach enforcement:
      // coercing a bad shape to [] would silently lift the restriction, so
      // anything that isn't strictly two string arrays is a cache miss and
      // the DB-backed config applies instead.
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        isStringArray(parsed.allowedFormats) &&
        isStringArray(parsed.allowedEndpoints)
      ) {
        return {
          allowedFormats: parsed.allowedFormats,
          allowedEndpoints: parsed.allowedEndpoints,
        };
      }
      logger.warn("Ignoring malformed key restriction cache entry", {
        apiKeyId,
      });
    }
  } catch (error) {
    logger.warn("Failed to read key restriction config cache", {
      apiKeyId,
      error,
    });
  }

  const [row] = await dbRr
    .select({
      allowed_formats: schema.key_restriction_config.allowed_formats,
      allowed_endpoints: schema.key_restriction_config.allowed_endpoints,
    })
    .from(schema.key_restriction_config)
    .where(eq(schema.key_restriction_config.api_key_id, apiKeyId))
    .limit(1);

  // A missing row means the key is unrestricted; cached the same way as a
  // configured row so unrestricted keys of flagged teams also skip the DB.
  const config: KeyRestrictionConfig = {
    allowedFormats: asStringArray(row?.allowed_formats),
    allowedEndpoints: asStringArray(row?.allowed_endpoints),
  };

  try {
    await setValue(cacheKey, JSON.stringify(config), CONFIG_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn("Failed to cache key restriction config", { apiKeyId, error });
  }

  return config;
}

// Endpoint groups a key can be allowlisted for. Job-status/cancel endpoints
// share the group of their job type, so allowing e.g. "crawl" covers both
// starting crawls and reading their results. First segment-prefix match wins,
// so nested paths ("/search/research") must precede their parent ("/search").
const ENDPOINT_GROUPS: [string[], string][] = [
  [["scrape", ":jobId", "interact"], "browser"],
  [["scrape"], "scrape"],
  [["batch", "scrape"], "batch-scrape"],
  [["crawl"], "crawl"],
  [["map"], "map"],
  [["search", "research"], "research"],
  [["search", "developer"], "research"],
  [["search", "gov"], "research"],
  [["search"], "search"],
  [["extract"], "extract"],
  [["agent"], "agent"],
  [["parse"], "parse"],
  [["browser", "profiles"], "profiles"],
  [["interact", "profiles"], "profiles"],
  [["browser"], "browser"],
  [["interact"], "browser"],
  [["monitor"], "monitor"],
  [["research"], "research"],
  [["developer"], "research"],
  [["llmstxt"], "llmstxt"],
  [["deep-research"], "deep-research"],
  [["alexandria"], "alexandria"],
  [["computer"], "computer"],
  [["team"], "account"],
  [["concurrency-check"], "account"],
  [["slack"], "account"],
];

// Metadata/support endpoints that never fetch web content; always reachable
// regardless of the endpoint allowlist.
const ALWAYS_ALLOWED_PREFIXES = ["feedback", "support", "keyless"];

function matchSegments(segments: string[], pattern: string[]): boolean {
  if (segments.length < pattern.length) return false;
  return pattern.every((part, i) =>
    part === ":jobId" ? segments[i].length > 0 : segments[i] === part,
  );
}

type EndpointClassification =
  | { api: "v0" }
  | {
      api: "v1" | "v2" | "labs" | "exchange";
      group: string | null;
      alwaysAllowed: boolean;
    }
  | null;

// Classifies a request path into an allowlistable endpoint group. Returns
// null for paths outside the key-authenticated API surface (health, admin,
// ...).
export function classifyEndpoint(rawUrl: string): EndpointClassification {
  // Express routes case-insensitively, so classify the same way.
  const pathname = rawUrl.split("?")[0].toLowerCase();
  const segments = pathname.split("/").filter(s => s.length > 0);
  const version = segments[0];
  if (version === "v0") {
    return { api: "v0" };
  }
  // Key-authenticated routers mounted beside the versioned API. The provider
  // catalogue and provider calls belong with /v2/alexandria; everything else
  // on them has no group, so an endpoint allowlist refuses it.
  if (version === "labs" || version === "exchange") {
    const providerCall =
      version === "exchange" &&
      (segments[1] === "discover" || segments[1] === "retrieve");
    return {
      api: version,
      group: providerCall ? "alexandria" : null,
      alwaysAllowed: false,
    };
  }
  if (version !== "v1" && version !== "v2") {
    return null;
  }

  const rest = segments.slice(1);
  if (rest.length > 0 && ALWAYS_ALLOWED_PREFIXES.includes(rest[0])) {
    return { api: version, group: null, alwaysAllowed: true };
  }

  for (const [pattern, group] of ENDPOINT_GROUPS) {
    if (matchSegments(rest, pattern)) {
      return { api: version, group, alwaysAllowed: false };
    }
  }

  return { api: version, group: null, alwaysAllowed: false };
}

type KeyRestrictionResult =
  | { allowed: true }
  | { allowed: false; error: string; status: number };

// Pure allowlist decision, split out for unit testing.
export function isEndpointAllowed(
  rawUrl: string,
  config: KeyRestrictionConfig,
): KeyRestrictionResult {
  if (!isKeyRestricted(config)) {
    return { allowed: true };
  }

  const classification = classifyEndpoint(rawUrl);

  if (classification === null) {
    // Not a versioned API path; nothing to enforce here.
    return { allowed: true };
  }

  // The v0 legacy API predates format controls entirely (e.g. raw HTML via
  // pageOptions), so any restricted key loses access to it outright.
  if (classification.api === "v0") {
    return {
      allowed: false,
      error: `Request blocked: this API key is restricted and cannot use the legacy v0 API. Please use the v2 API instead. Team admins can manage key restrictions at ${MANAGE_RESTRICTIONS_URL}`,
      status: 403,
    };
  }

  if (
    config.allowedEndpoints.length === 0 ||
    classification.alwaysAllowed ||
    (classification.group !== null &&
      config.allowedEndpoints.includes(classification.group))
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: `Request blocked: this API key is restricted to the following endpoints: ${config.allowedEndpoints.join(", ")}. Team admins can manage key restrictions at ${MANAGE_RESTRICTIONS_URL}`,
    status: 403,
  };
}

// A saved browser profile is a logged-in session, so a key with an endpoint
// allowlist may load, save or delete one only when "profiles" is on the list.
// Pure decision, split out for unit testing.
export function isProfileAllowed(
  config: KeyRestrictionConfig,
): KeyRestrictionResult {
  if (
    config.allowedEndpoints.length === 0 ||
    config.allowedEndpoints.includes("profiles")
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: `Request blocked: this API key is restricted and cannot use saved browser profiles. Team admins can manage key restrictions at ${MANAGE_RESTRICTIONS_URL}`,
    status: 403,
  };
}

// Content-returning actions are side channels around the format allowlist:
// their output lands in actions.scrapes / javascriptReturns / pdfs /
// screenshots regardless of the requested formats.
const ACTION_FORMAT_EQUIVALENTS: Record<string, string | null> = {
  screenshot: "screenshot",
  // No format equivalent — always rejected for format-restricted keys.
  scrape: null,
  executeJavascript: null,
  pdf: null,
};

// v1 format names that differ from the v2 type names the allowlist stores.
const V1_FORMAT_ALIASES: Record<string, string> = {
  "screenshot@fullPage": "screenshot",
  extract: "json",
};

export function normalizeFormatForRestriction(format: string): string {
  return V1_FORMAT_ALIASES[format] ?? format;
}

// Extraction helpers so controllers can pass formats in either shape:
// v1 uses plain strings, v2 uses { type } objects.
export function formatTypesOf(
  formats: readonly (string | { type: string })[] | undefined,
): string[] {
  return (formats ?? []).map(f => (typeof f === "string" ? f : f.type));
}

export function actionTypesOf(
  actions: readonly { type: string }[] | undefined,
): string[] {
  return (actions ?? []).map(a => a.type);
}

// Pure format decision, split out for unit testing. `formats` are v2 format
// type names (v1 callers normalize first); `actionTypes` are the requested
// action types, if any.
export function areFormatsAllowed(
  formats: string[],
  actionTypes: string[],
  config: KeyRestrictionConfig,
): KeyRestrictionResult {
  if (config.allowedFormats.length === 0) {
    return { allowed: true };
  }

  const blockedFormats = formats
    .map(normalizeFormatForRestriction)
    .filter(format => !config.allowedFormats.includes(format));
  if (blockedFormats.length > 0) {
    return {
      allowed: false,
      error: `Request blocked: this API key is restricted to the following formats: ${config.allowedFormats.join(", ")}. Requested formats not allowed: ${[...new Set(blockedFormats)].join(", ")}. Team admins can manage key restrictions at ${MANAGE_RESTRICTIONS_URL}`,
      status: 403,
    };
  }

  for (const actionType of actionTypes) {
    if (!(actionType in ACTION_FORMAT_EQUIVALENTS)) {
      continue;
    }
    const equivalent = ACTION_FORMAT_EQUIVALENTS[actionType];
    if (equivalent === null || !config.allowedFormats.includes(equivalent)) {
      return {
        allowed: false,
        error: `Request blocked: the "${actionType}" action returns page content and is not available on this format-restricted API key. Team admins can manage key restrictions at ${MANAGE_RESTRICTIONS_URL}`,
        status: 403,
      };
    }
  }

  return { allowed: true };
}

// The parts of the auth chunk that decide whether a key's config is looked up.
type RestrictableKey = Pick<
  AuthCreditUsageChunk,
  "api_key_id" | "flags" | "is_key_restricted"
>;

function keyRestrictionApplies(
  key: RestrictableKey | null | undefined,
): key is RestrictableKey {
  // The config is looked up only when the team has the keyRestriction flag
  // (its admins can restrict any key in the dashboard) or the auth chunk says
  // this key has a non-empty config, so an unrestricted key on an unflagged
  // team pays zero cost. Preview/keyless tokens have no api_key_id and are
  // never restricted.
  return (
    Boolean(key?.api_key_id) &&
    (Boolean(key?.flags?.keyRestriction) || key?.is_key_restricted === true)
  );
}

function failClosed(apiKeyId: number, error: unknown): KeyRestrictionResult {
  logger.error("Failed to load key restriction config", { apiKeyId, error });
  // Fail closed: the key is restricted or its team opted into key
  // restriction, so an unverifiable request must not slip through.
  return {
    allowed: false,
    error:
      "Internal error while verifying this API key's restrictions. Please try again shortly.",
    status: 500,
  };
}

/**
 * Enforces the per-key endpoint allowlist (key_restriction_config table) for
 * keys the auth chunk marks as restricted and for teams with the
 * keyRestriction flag. Called during authentication so it
 * covers every authenticated route uniformly. An empty or missing config
 * means no restriction, so a team can't lock itself out before configuring.
 */
export async function checkKeyEndpointRestriction(
  rawUrl: string,
  key: RestrictableKey | null | undefined,
): Promise<KeyRestrictionResult> {
  if (!keyRestrictionApplies(key)) {
    return { allowed: true };
  }

  let config: KeyRestrictionConfig;
  try {
    config = await getKeyRestrictionConfig(key.api_key_id);
  } catch (error) {
    return failClosed(key.api_key_id, error);
  }

  return isEndpointAllowed(rawUrl, config);
}

/**
 * Enforces the per-key format allowlist on a parsed scrape-output request.
 * Called by the scrape/batch-scrape/crawl/search controllers after zod
 * parsing, so the checked formats are the normalized ones the job will
 * actually run with — request flags can't sidestep it. `profile` is the
 * request's saved browser profile option, refused as in
 * checkKeyProfileRestriction.
 */
export async function checkKeyFormatRestriction(
  formats: string[],
  actionTypes: string[],
  key: RestrictableKey | null | undefined,
  profile?: unknown,
): Promise<KeyRestrictionResult> {
  if (!keyRestrictionApplies(key)) {
    return { allowed: true };
  }

  let config: KeyRestrictionConfig;
  try {
    config = await getKeyRestrictionConfig(key.api_key_id);
  } catch (error) {
    return failClosed(key.api_key_id, error);
  }

  if (profile !== undefined) {
    const profileCheck = isProfileAllowed(config);
    if (!profileCheck.allowed) {
      return profileCheck;
    }
  }

  return areFormatsAllowed(formats, actionTypes, config);
}

/**
 * Refuses a saved browser profile for a key whose endpoint allowlist does not
 * name "profiles". Called where a request names a profile outside the format
 * check above (browser sessions, interact, extract, parse, monitors).
 */
export async function checkKeyProfileRestriction(
  key: RestrictableKey | null | undefined,
): Promise<KeyRestrictionResult> {
  if (!keyRestrictionApplies(key)) {
    return { allowed: true };
  }

  let config: KeyRestrictionConfig;
  try {
    config = await getKeyRestrictionConfig(key.api_key_id);
  } catch (error) {
    return failClosed(key.api_key_id, error);
  }

  return isProfileAllowed(config);
}
