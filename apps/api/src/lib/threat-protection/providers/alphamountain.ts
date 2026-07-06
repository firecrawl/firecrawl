import { config } from "../../../config";
import { logger } from "../../logger";
import type { RawVerdict, ThreatProvider } from "../types";
import { ALPHAMOUNTAIN_CATEGORY_NAMES } from "./alphamountain-categories";

// alphaMountain provider ("enhanced" threat protection mode). Three POST
// endpoints on api.alphamountain.ai (swagger:
// https://www.alphamountain.ai/api/swagger.yaml), called in parallel:
//   - /threat/uri     → threat.score, 0.0 (known good) … 10.0 (known bad),
//                       normalized here to 0-100
//   - /category/uri   → category.categories (numeric IDs → names via the
//                       embedded mapping)
//   - /intelligence/hostname (sections whois + geo) → domain registration
//                       date and hosting country (best-effort)
// Threat + category are required — if either fails we throw so the caller can
// apply the org's failurePolicy. The intelligence call is best-effort context:
// on failure, domainAgeDays/countryCode are null.

const PROVIDER: ThreatProvider = "alphamountain";

const API_VERSION = 1;
const REQUEST_TYPE = "partner.info";

type AlphaMountainThreatResponse = {
  version?: number;
  status?: { threat?: string };
  threat?: { score?: number; scope?: string; source?: string };
  ttl?: number;
};

type AlphaMountainCategoryResponse = {
  version?: number;
  status?: { category?: string };
  category?: { categories?: number[]; scope?: string; confidence?: number };
  ttl?: number;
};

type AlphaMountainIntelligenceResponse = {
  version?: number;
  status?: Record<string, string>;
  sections?: { whois?: unknown; geo?: unknown };
  errors?: Record<string, string>;
};

function isAlphaMountainConfigured(): boolean {
  return (
    typeof config.ALPHAMOUNTAIN_API_KEY === "string" &&
    config.ALPHAMOUNTAIN_API_KEY.trim().length > 0
  );
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${config.ALPHAMOUNTAIN_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: API_VERSION,
      license: config.ALPHAMOUNTAIN_API_KEY!,
      ...body,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `alphaMountain ${path} request failed with status ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

/** alphaMountain threat scores are 0.0-10.0; normalize to the 0-100 contract. */
function normalizeScore(score: number | undefined | null): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return Math.min(100, Math.max(0, Math.round(score * 10)));
}

function mapCategories(ids: number[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.map(id => ALPHAMOUNTAIN_CATEGORY_NAMES[id] ?? `category-${id}`);
}

/**
 * Best-effort extraction of the domain registration timestamp from the whois
 * intelligence section. The section's exact shape isn't pinned by the swagger
 * ("raw whois record and parsed values"), so we probe the common key spellings
 * anywhere in the (shallow) structure.
 */
function extractDomainAgeDays(whois: unknown): number | null {
  const candidateKeys = [
    "created",
    "created_date",
    "createddate",
    "creation_date",
    "creationdate",
    "registered",
    "registered_date",
    "domain_registered",
  ];
  const visit = (value: unknown, depth: number): string | number | null => {
    if (depth > 3 || value === null || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (
        candidateKeys.includes(key.toLowerCase()) &&
        (typeof entry === "string" || typeof entry === "number")
      ) {
        return entry;
      }
    }
    for (const entry of Object.values(record)) {
      const found = visit(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  const rawDate = visit(whois, 0);
  if (rawDate === null) return null;
  const createdAt = new Date(rawDate);
  if (Number.isNaN(createdAt.getTime())) return null;
  const ageMs = Date.now() - createdAt.getTime();
  if (ageMs < 0) return null;
  return Math.floor(ageMs / (24 * 60 * 60 * 1000));
}

/**
 * Best-effort extraction of an ISO 3166-1 alpha-2 country code from the geo
 * intelligence section (geolocation of the domain's resolved IPs). The live
 * API (verified 2026-07-05) returns
 * `{ ipv4: [{ ip, isoCode: "US", country: "United States", ... }], ipv6: [...], ns: [...] }`
 * — `isoCode` is the alpha-2 field; `country` is a full name and is kept only
 * as a fallback for 2-letter values.
 */
function extractCountryCode(geo: unknown): string | null {
  const candidateKeys = [
    "isocode",
    "country_code",
    "countrycode",
    "country_iso",
    "country",
  ];
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 3 || value === null || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = visit(entry, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (
        candidateKeys.includes(key.toLowerCase()) &&
        typeof entry === "string" &&
        /^[a-zA-Z]{2}$/.test(entry.trim())
      ) {
        return entry.trim().toUpperCase();
      }
    }
    for (const entry of Object.values(record)) {
      const found = visit(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(geo, 0);
}

/**
 * Look up a domain against alphaMountain (threat score, content categories,
 * and WHOIS/geo context). Throws if the threat or category lookup fails so the
 * caller can apply the org's failurePolicy.
 */
export async function fetchAlphaMountainVerdict(
  domain: string,
  options?: { signal?: AbortSignal },
): Promise<RawVerdict> {
  if (!isAlphaMountainConfigured()) {
    throw new Error("alphaMountain is not configured");
  }

  const uri = `http://${domain}/`;
  const [threat, category, intelligence] = await Promise.all([
    postJson<AlphaMountainThreatResponse>(
      "/threat/uri",
      { uri, type: REQUEST_TYPE, scan_depth: "low" },
      options?.signal,
    ),
    postJson<AlphaMountainCategoryResponse>(
      "/category/uri",
      { uri, type: REQUEST_TYPE },
      options?.signal,
    ),
    postJson<AlphaMountainIntelligenceResponse>(
      "/intelligence/hostname",
      { hostname: domain, sections: ["whois", "geo"] },
      options?.signal,
    ).catch((error): AlphaMountainIntelligenceResponse | null => {
      // Intelligence (domain age / country) is best-effort enrichment; the
      // verdict is still valid without it.
      logger.warn("alphaMountain intelligence lookup failed", {
        canonicalLog: "threat-protection/provider",
        provider: "alphamountain",
        domain,
        error,
      });
      return null;
    }),
  ]);

  // alphaMountain reports semantic failures (quota, license issues) inside
  // HTTP 200 bodies via status.*. Only "Success" and "Not Found" (domain
  // unrated) are valid outcomes; anything else must throw so the caller
  // routes it through retry and the org's failurePolicy — a silent
  // riskScore:null + categories:[] verdict would read as benign.
  const threatStatus = threat.status?.threat;
  if (threatStatus !== "Success" && threatStatus !== "Not Found") {
    throw new Error(
      `alphaMountain threat lookup returned status "${threatStatus ?? "missing"}"`,
    );
  }
  const categoryStatus = category.status?.category;
  if (categoryStatus !== "Success" && categoryStatus !== "Not Found") {
    throw new Error(
      `alphaMountain category lookup returned status "${categoryStatus ?? "missing"}"`,
    );
  }

  const score = normalizeScore(
    threatStatus === "Not Found" ? null : threat.threat?.score,
  );

  return {
    provider: PROVIDER,
    riskScore: score,
    categories: mapCategories(category.category?.categories),
    domainAgeDays: extractDomainAgeDays(intelligence?.sections?.whois),
    countryCode: extractCountryCode(intelligence?.sections?.geo),
    fromCache: false,
    raw: { threat, category, intelligence },
  };
}
