import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { z } from "zod";
import { logger as _logger } from "../../../logger";
import { redisRateLimitClient } from "../../../../services/rate-limiter";
import { redlock } from "../../../../services/redlock";
import { getOrgZscalerCredentials } from "../../store";
import type {
  ThreatDecision,
  ThreatProtectionPolicy,
  ZscalerPolicySettings,
} from "../../types";
import { canonicalizeHost, splitUrl } from "../web-risk/canonicalize";
import {
  ZscalerError,
  zscalerGetUrlCategories,
  type ZscalerCredentials,
  type ZscalerUrlCategory,
} from "./client";
import { zscalerBudgetKey } from "./lookup-queue";

// Synchronization plane for the Zscaler ZIA provider.
//
// POST /urlLookup never returns custom URL classifications ("Custom URL
// classification is not returned by this request" — ZIA API docs), so the
// tenant's custom categories, custom-category keywords, and customer
// additions to Zscaler-defined categories (dbCategorizedUrls) are synced via
// GET /urlCategories and evaluated locally against every checked URL.
//
// The synced document holds the customer's own policy configuration — never
// scrape-derived data — so persisting it in Redis is compatible with
// zero-data-retention requirements (same reasoning as the org-config cache
// in ../../store.ts).
//
// Sync runs lazily: any process that notices the document is older than the
// org's sync interval kicks a re-sync in the background, guarded by a
// distributed lock so only one process calls the tenant per interval. There
// is no dedicated sync worker to deploy or babysit. Each sync replaces the
// whole document, so entries removed upstream disappear on the next pass.
//
// Keyword matching note: locally re-implementing Zscaler's keyword semantics
// exactly is not possible from the published docs. We apply the documented
// best-effort approximation (case-insensitive substring over the schemeless
// URL); URL-list entries match exactly.

const logger = _logger.child({ module: "threat-protection-zscaler-sync" });

const SYNC_DOC_VERSION = 1;
const syncDocKey = (orgId: string) => `threat-protection:zscaler:sync:${orgId}`;
const syncLockKey = (orgId: string) =>
  `threat-protection:zscaler:sync-lock:${orgId}`;

// Process-local cache of the parsed sync document so the enforcement hot
// path does not deserialize a potentially large Redis value per URL.
const DOC_CACHE_TTL_MS = 60_000;
const DOC_CACHE_MAX_ENTRIES = 100;
const docCache = new Map<
  string,
  { expiresAt: number; doc: ZscalerSyncDocument | null }
>();

/** One synced category's locally-evaluable content. */
export interface ZscalerSyncedRule {
  /** Category ID ("CUSTOM_01", or a Zscaler-defined ID with customer additions). */
  id: string;
  name: string;
  custom: boolean;
  /** URL-list entries that reclassify the URL into this category. */
  urls: string[];
  /** "Retaining parent category" URL entries — the URL keeps its Zscaler-defined categories too. */
  retainingUrls: string[];
  /** Keywords that reclassify (best-effort substring match). */
  keywords: string[];
  /** "Retaining parent category" keywords. */
  retainingKeywords: string[];
}

export interface ZscalerTaxonomyEntry {
  id: string;
  name: string;
  custom: boolean;
}

export interface ZscalerSyncDocument {
  version: number;
  status: "ok" | "error";
  /** Last successful sync; null when no sync has ever succeeded. */
  syncedAt: string | null;
  attemptedAt: string;
  error: string | null;
  taxonomy: ZscalerTaxonomyEntry[];
  rules: ZscalerSyncedRule[];
}

const syncedRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  custom: z.boolean(),
  urls: z.array(z.string()),
  retainingUrls: z.array(z.string()),
  keywords: z.array(z.string()),
  retainingKeywords: z.array(z.string()),
});

const syncDocumentSchema = z.object({
  version: z.number(),
  status: z.enum(["ok", "error"]),
  syncedAt: z.string().nullable(),
  attemptedAt: z.string(),
  error: z.string().nullable(),
  taxonomy: z.array(
    z.object({ id: z.string(), name: z.string(), custom: z.boolean() }),
  ),
  rules: z.array(syncedRuleSchema),
});

// =========================================
// Document storage
// =========================================

export async function getZscalerSyncDocument(
  orgId: string,
): Promise<ZscalerSyncDocument | null> {
  const cached = docCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;

  let doc: ZscalerSyncDocument | null = null;
  try {
    const raw = await redisRateLimitClient.get(syncDocKey(orgId));
    if (raw !== null) {
      doc = syncDocumentSchema.parse(JSON.parse(raw));
    }
  } catch (error) {
    logger.warn("Failed to read the Zscaler sync document", { error, orgId });
    // Treat as missing: the caller decides via failure semantics.
    doc = null;
  }

  const now = Date.now();
  for (const [key, entry] of docCache) {
    if (entry.expiresAt <= now) docCache.delete(key);
  }
  while (docCache.size >= DOC_CACHE_MAX_ENTRIES) {
    const oldest = docCache.keys().next().value;
    if (oldest === undefined) break;
    docCache.delete(oldest);
  }
  docCache.set(orgId, { expiresAt: now + DOC_CACHE_TTL_MS, doc });
  return doc;
}

async function putZscalerSyncDocument(
  orgId: string,
  doc: ZscalerSyncDocument,
): Promise<void> {
  await redisRateLimitClient.set(syncDocKey(orgId), JSON.stringify(doc));
  docCache.set(orgId, { expiresAt: Date.now() + DOC_CACHE_TTL_MS, doc });
}

/** Removes all synced state; used when the org's Zscaler connection is removed. */
export async function clearZscalerSyncState(orgId: string): Promise<void> {
  docCache.delete(orgId);
  await redisRateLimitClient.del(syncDocKey(orgId));
}

// =========================================
// Sync
// =========================================

// GET /urlCategories budget (ZIA: 1,000/hour per tenant). Shared between
// interval syncs, dashboard "sync now", and connection tests.
let categoriesBudget: RateLimiterRedis | undefined;
function getCategoriesBudget(): RateLimiterRedis {
  if (!categoriesBudget) {
    categoriesBudget = new RateLimiterRedis({
      storeClient: redisRateLimitClient,
      keyPrefix: "threat-protection:zscaler:categories-budget",
      // ZIA's published urlCategories quota is 1,000 calls/hour per tenant.
      points: 900,
      duration: 3600,
    });
  }
  return categoriesBudget;
}

/**
 * Spend one point of the tenant's urlCategories budget (interval syncs,
 * "Sync now", and the connection test's taxonomy read all share it). Throws
 * a quota ZscalerError when exhausted.
 */
export async function consumeZscalerCategoriesBudget(
  credentials: ZscalerCredentials,
): Promise<void> {
  try {
    await getCategoriesBudget().consume(zscalerBudgetKey(credentials), 1);
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) {
      throw new ZscalerError(
        "quota",
        "Zscaler urlCategories hourly budget is exhausted",
        undefined,
        rejection.msBeforeNext,
      );
    }
    throw rejection;
  }
}

const MAX_LIST_ENTRY_LENGTH = 2048;

function cleanEntries(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const cleaned = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length === 0 || trimmed.length > MAX_LIST_ENTRY_LENGTH) {
      continue;
    }
    cleaned.add(trimmed);
  }
  return [...cleaned];
}

/**
 * Turns the GET /urlCategories payload into the synced document's taxonomy
 * and locally-evaluable rules. Exported for tests.
 */
export function materializeCategories(categories: ZscalerUrlCategory[]): {
  taxonomy: ZscalerTaxonomyEntry[];
  rules: ZscalerSyncedRule[];
} {
  const taxonomy: ZscalerTaxonomyEntry[] = [];
  const rules: ZscalerSyncedRule[] = [];

  for (const category of categories) {
    const name =
      typeof category.configuredName === "string" &&
      category.configuredName.trim().length > 0
        ? category.configuredName.trim()
        : category.id;
    const custom = category.customCategory === true;
    taxonomy.push({ id: category.id, name, custom });

    const rule: ZscalerSyncedRule = {
      id: category.id,
      name,
      custom,
      urls: cleanEntries(category.urls),
      retainingUrls: cleanEntries(category.dbCategorizedUrls),
      keywords: cleanEntries(category.keywords),
      retainingKeywords: cleanEntries(category.keywordsRetainingParentCategory),
    };
    if (
      rule.urls.length > 0 ||
      rule.retainingUrls.length > 0 ||
      rule.keywords.length > 0 ||
      rule.retainingKeywords.length > 0
    ) {
      rules.push(rule);
    }
  }

  taxonomy.sort((a, b) => a.name.localeCompare(b.name));
  return { taxonomy, rules };
}

/**
 * Fetches the tenant taxonomy and replaces the org's synced document.
 * Distributed-lock guarded: when another process is already syncing, this
 * returns the current document without calling the tenant. Throws only when
 * there is no usable document at all (first sync failing).
 */
export async function syncOrgZscalerRules(
  orgId: string,
): Promise<ZscalerSyncDocument | null> {
  let lock;
  try {
    lock = await redlock.acquire([syncLockKey(orgId)], 120_000, {
      retryCount: 0,
    });
  } catch (error) {
    // Redlock reports contention and infrastructure failure with the same
    // error; the lock key existing is what distinguishes "someone else is
    // syncing" (return their in-progress state) from a Redis outage (which
    // must surface, not masquerade as a successful no-op).
    let lockHeld = false;
    try {
      lockHeld = (await redisRateLimitClient.exists(syncLockKey(orgId))) === 1;
    } catch {
      // Redis is down; fall through to rethrow the original error.
    }
    if (lockHeld) {
      return await getZscalerSyncDocument(orgId);
    }
    throw error;
  }

  try {
    const previous = await getZscalerSyncDocument(orgId);
    const attemptedAt = new Date().toISOString();

    const credentials = await getOrgZscalerCredentials(orgId);
    if (!credentials) {
      logger.warn("Zscaler sync requested for an org without credentials", {
        orgId,
      });
      return previous;
    }

    try {
      await consumeZscalerCategoriesBudget(credentials);
      const categories = await zscalerGetUrlCategories(credentials, {
        signal: AbortSignal.timeout(60_000),
      });
      const { taxonomy, rules } = materializeCategories(categories);
      const doc: ZscalerSyncDocument = {
        version: SYNC_DOC_VERSION,
        status: "ok",
        syncedAt: attemptedAt,
        attemptedAt,
        error: null,
        taxonomy,
        rules,
      };
      await putZscalerSyncDocument(orgId, doc);
      logger.info("Zscaler category sync succeeded", {
        orgId,
        categories: taxonomy.length,
        rules: rules.length,
      });
      return doc;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Zscaler category sync failed", { error, orgId });
      // Keep the last good rules — stale custom lists beat no custom lists —
      // but surface the failure and its time for the dashboard.
      const doc: ZscalerSyncDocument = {
        version: SYNC_DOC_VERSION,
        status: "error",
        syncedAt: previous?.syncedAt ?? null,
        attemptedAt,
        error: message,
        taxonomy: previous?.taxonomy ?? [],
        rules: previous?.rules ?? [],
      };
      await putZscalerSyncDocument(orgId, doc);
      return doc;
    }
  } finally {
    await lock.release().catch(() => {});
  }
}

const syncsInFlight = new Set<string>();

/**
 * Fire-and-forget staleness check used by the enforcement hot path: when the
 * synced document is missing or older than the org's sync interval, kick a
 * background re-sync (at most one per process at a time per org).
 */
function ensureZscalerSyncFresh(
  orgId: string,
  syncIntervalMinutes: number,
  doc: ZscalerSyncDocument | null,
): void {
  const intervalMs = syncIntervalMinutes * 60_000;
  if (
    doc &&
    doc.attemptedAt &&
    Date.now() - Date.parse(doc.attemptedAt) < intervalMs
  ) {
    return;
  }
  if (syncsInFlight.has(orgId)) return;
  syncsInFlight.add(orgId);
  syncOrgZscalerRules(orgId)
    .catch(error => {
      logger.warn("Background Zscaler sync failed", { error, orgId });
    })
    .finally(() => {
      syncsInFlight.delete(orgId);
    });
}

// =========================================
// Local rule evaluation
// =========================================

interface UrlParts {
  host: string;
  /** Path + optional query, always starting with "/". */
  pathAndQuery: string;
}

function parseUrlParts(url: string): UrlParts {
  const { host, path, query } = splitUrl(url.trim().replace(/[\t\r\n]/g, ""));
  return {
    host: canonicalizeHost(host),
    pathAndQuery:
      `${path || "/"}${query !== null ? `?${query}` : ""}`.toLowerCase(),
  };
}

/**
 * Whether a URL-list entry ("example.com", "sub.example.com/path",
 * "internal.example.com:8443") matches. Host matching follows Zscaler list
 * semantics: an entry matches the host itself and its subdomains. An entry
 * with a path component additionally requires the URL path to sit under it.
 * Ports are ignored on both sides — the checked host comes from splitUrl
 * (port already stripped), so a port kept in the entry could never match
 * and the rule would silently not enforce.
 */
function matchesZscalerUrlEntry(parts: UrlParts, entry: string): boolean {
  const slash = entry.indexOf("/");
  let entryHostRaw = slash === -1 ? entry : entry.slice(0, slash);
  const portMatch = entryHostRaw.match(/^(.*):(\d+)$/);
  if (portMatch) entryHostRaw = portMatch[1];
  const entryHost = canonicalizeHost(entryHostRaw);
  if (entryHost.length === 0) return false;
  if (parts.host !== entryHost && !parts.host.endsWith(`.${entryHost}`)) {
    return false;
  }
  if (slash === -1) return true;
  let entryPath = entry.slice(slash).toLowerCase();
  if (!entryPath.startsWith("/")) entryPath = `/${entryPath}`;
  return parts.pathAndQuery.startsWith(entryPath);
}

/**
 * Best-effort keyword match: case-insensitive substring over the schemeless
 * URL ("host/path?query"), which is how ZIA keyword categories are commonly
 * understood to behave. Documented as an approximation.
 */
function matchesKeyword(parts: UrlParts, keyword: string): boolean {
  return `${parts.host}${parts.pathAndQuery}`.includes(keyword);
}

interface ZscalerSyncedMatch {
  rule: ZscalerSyncedRule;
  /** True when the matching entry reclassifies (non-"retaining") the URL. */
  reclassifies: boolean;
  /**
   * True when the match came from a URL-list entry (exact semantics). A
   * keyword match is a best-effort approximation and must never be the
   * reason a URL SKIPS the provider lookup — only exact matches may allow.
   */
  exact: boolean;
}

/** All synced categories the URL falls into. Exported for tests. */
export function matchSyncedRules(
  url: string,
  rules: ZscalerSyncedRule[],
): ZscalerSyncedMatch[] {
  const parts = parseUrlParts(url);
  const matches: ZscalerSyncedMatch[] = [];
  for (const rule of rules) {
    const exactReclassify = rule.urls.some(entry =>
      matchesZscalerUrlEntry(parts, entry),
    );
    const keywordReclassify =
      !exactReclassify &&
      rule.keywords.some(keyword => matchesKeyword(parts, keyword));
    const reclassifies = exactReclassify || keywordReclassify;
    const exactRetain =
      !reclassifies &&
      rule.retainingUrls.some(entry => matchesZscalerUrlEntry(parts, entry));
    const keywordRetain =
      !reclassifies &&
      !exactRetain &&
      rule.retainingKeywords.some(keyword => matchesKeyword(parts, keyword));
    if (reclassifies || exactRetain || keywordRetain) {
      matches.push({
        rule,
        reclassifies,
        exact: exactReclassify || exactRetain,
      });
    }
  }
  return matches;
}

// Custom category IDs follow this shape; Zscaler-defined categories never do.
const CUSTOM_CATEGORY_ID_REGEX = /^CUSTOM_\d+$/i;

/**
 * Evaluates the org's synced Zscaler rules for a URL.
 *
 * - A match in a denied category → deny ("denied-category"), no provider call.
 * - An exact (URL-list) reclassifying match in a non-denied category → allow
 *   ("custom-category"), no provider call: ZIA reclassifies such URLs out of
 *   their Zscaler-defined categories, so a lookup verdict would not apply.
 *   Keyword matches are approximate and never allow on their own — the
 *   provider lookup still runs.
 * - Only "retaining parent category" matches in non-denied categories →
 *   null: the URL also keeps its Zscaler-defined categories, so the provider
 *   lookup still decides.
 * - No match → null (provider lookup decides).
 *
 * When the org denies custom categories but no sync has ever succeeded, the
 * custom rules cannot be evaluated AND the lookup cannot see them (urlLookup
 * never returns custom classifications) — that resolves through the org's
 * failurePolicy instead of silently allowing. A previously synced (stale)
 * document keeps enforcing.
 *
 * Never throws on storage failure; also kicks the lazy background re-sync.
 */
export async function evaluateZscalerSyncedRules(
  url: string,
  zscaler: ZscalerPolicySettings,
  failurePolicy: ThreatProtectionPolicy["failurePolicy"],
  base: {
    url: string;
    domain: string;
    mode: ThreatProtectionPolicy["mode"];
  },
): Promise<ThreatDecision | null> {
  let doc: ZscalerSyncDocument | null = null;
  try {
    doc = await getZscalerSyncDocument(zscaler.orgId);
  } catch (error) {
    logger.warn("Failed to load synced Zscaler rules", {
      error,
      orgId: zscaler.orgId,
    });
  }
  ensureZscalerSyncFresh(zscaler.orgId, zscaler.syncIntervalMinutes, doc);

  if (!doc || doc.syncedAt === null) {
    const deniesCustomCategories = zscaler.deniedCategories.some(id =>
      CUSTOM_CATEGORY_ID_REGEX.test(id),
    );
    if (deniesCustomCategories) {
      return {
        allowed: failurePolicy === "open",
        rule: "provider-failure",
        providerConsulted: false,
        verdict: null,
        ...base,
      };
    }
    return null;
  }
  if (doc.rules.length === 0) return null;

  const matches = matchSyncedRules(url, doc.rules);
  if (matches.length === 0) return null;

  const denied = matches.filter(match =>
    zscaler.deniedCategories.includes(match.rule.id),
  );
  if (denied.length > 0) {
    return {
      allowed: false,
      rule: "denied-category",
      providerConsulted: false,
      verdict: {
        provider: "zscaler-zia",
        riskScore: null,
        categories: denied.map(match => match.rule.id),
        fromCache: false,
        raw: {
          source: "synced-rules",
          matched: denied.map(match => ({
            category: match.rule.id,
            reclassifies: match.reclassifies,
          })),
        },
      },
      ...base,
    };
  }

  if (matches.some(match => match.reclassifies && match.exact)) {
    return {
      allowed: true,
      rule: "custom-category",
      providerConsulted: false,
      verdict: null,
      ...base,
    };
  }

  return null;
}
