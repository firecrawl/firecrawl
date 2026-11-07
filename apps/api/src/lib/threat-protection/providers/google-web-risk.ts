import { createHash } from "crypto";
import { config } from "../../../config";
import type { RawVerdict, ThreatProvider } from "../types";
import { generateUrlExpressions } from "./web-risk/canonicalize";
import {
  getWebRiskListStore,
  WEB_RISK_THREAT_TYPES,
  type WebRiskLookupResult,
  type WebRiskThreatType,
} from "./web-risk/store";
import {
  ensureThreatListBootSync,
  ensureThreatListSyncLoop,
} from "./web-risk/sync";

// Google Web Risk provider ("normal" threat protection mode), built on the
// Update API for ZDR compliance:
//
//  1. The URL is canonicalized into host-suffix × path-prefix expressions per
//     the Safe Browsing spec, each expression is SHA-256 hashed, and the
//     4-byte hash prefixes are checked against the locally synced threat
//     lists (./web-risk/store.ts + ./web-risk/sync.ts). No network I/O, and
//     the target URL is never transmitted anywhere.
//  2. Only when a local prefix matches (rare) is Google consulted:
//     GET /v1/hashes:search with the matched (anonymized, non-reversible)
//     hash prefix. The returned full hashes are compared locally — a full
//     match confirms the threat, a mismatch was a prefix collision (clean).
//     The response's ttl/negativeExpireTime metadata is deliberately ignored:
//     verdicts are never persisted (ZDR).
//
// Cost note: hashes:search is ~100x the price of the old uris:search per
// call, so it must ONLY ever run to confirm a local prefix hit — never per
// check. computeDiff (the sync path) is free.
//
// Web Risk gives a boolean-ish signal (flagged for a threat type or not), not
// a granular score — so we normalize any confirmed threat to riskScore 100 and
// a clean lookup to 0, and surface the threat types as category strings.

const PROVIDER: ThreatProvider = "google-web-risk";

interface HashesSearchThreat {
  hash?: string;
  threatTypes?: string[];
  expireTime?: string;
}

type HashesSearchResponse = {
  threats?: HashesSearchThreat[];
  negativeExpireTime?: string;
};

function isGoogleWebRiskConfigured(): boolean {
  return (
    typeof config.GOOGLE_WEB_RISK_API_KEY === "string" &&
    config.GOOGLE_WEB_RISK_API_KEY.trim().length > 0
  );
}

async function searchHashPrefix(
  prefix: Buffer,
  signal: AbortSignal | undefined,
): Promise<HashesSearchResponse> {
  const params = new URLSearchParams();
  params.append("hashPrefix", prefix.toString("base64"));
  for (const threatType of WEB_RISK_THREAT_TYPES) {
    params.append("threatTypes", threatType);
  }
  params.append("key", config.GOOGLE_WEB_RISK_API_KEY!);

  const response = await fetch(
    `${config.GOOGLE_WEB_RISK_API_URL}/v1/hashes:search?${params.toString()}`,
    { method: "GET", signal },
  );
  if (!response.ok) {
    throw new Error(
      `Google Web Risk hash search failed with status ${response.status}`,
    );
  }
  return (await response.json()) as HashesSearchResponse;
}

/**
 * Look up a URL against Google Web Risk. Throws on any transport/API
 * error, and when the local threat lists are unavailable or stale, so the
 * caller can apply the org's failurePolicy.
 */
export async function fetchGoogleWebRiskVerdict(
  url: string,
  options?: { signal?: AbortSignal },
): Promise<RawVerdict> {
  if (!isGoogleWebRiskConfigured()) {
    throw new Error("Google Web Risk is not configured");
  }

  ensureThreatListSyncLoop();

  const expressions = generateUrlExpressions(url);
  if (expressions.length === 0) {
    throw new Error(`Cannot canonicalize URL for Web Risk lookup`);
  }
  const fullHashes = expressions.map(expression =>
    createHash("sha256").update(expression).digest(),
  );

  const store = getWebRiskListStore();

  // Wait for the once-per-process boot sync (bounded by the caller's timeout
  // signal) so a fresh deployment doesn't fail every check while the lists
  // download; afterwards this resolves instantly.
  await abortable(ensureThreatListBootSync(), options?.signal);

  const lookup: WebRiskLookupResult = await store.lookup(fullHashes);
  if (lookup.status !== "ok") {
    throw new Error(`Web Risk threat lists are ${lookup.status}`);
  }

  if (lookup.hits.length === 0) {
    // The overwhelmingly common case: clean URL, zero Google calls,
    // nothing transmitted anywhere.
    return {
      provider: PROVIDER,
      riskScore: 0,
      categories: [],
      fromCache: false,
      raw: { localPrefixMatch: false },
    };
  }

  // Local prefix hit: confirm with hashes:search (only the anonymized hash
  // prefix leaves our infrastructure), then compare full hashes locally.
  const uniquePrefixes = new Map<string, Buffer>();
  for (const hit of lookup.hits) {
    uniquePrefixes.set(hit.prefix.toString("base64"), hit.prefix);
  }
  const responses = await Promise.all(
    [...uniquePrefixes.values()].map(prefix =>
      searchHashPrefix(prefix, options?.signal),
    ),
  );

  const fullHashSet = new Set(fullHashes.map(hash => hash.toString("base64")));
  const confirmedThreatTypes = new Set<string>();
  for (const response of responses) {
    for (const threat of response.threats ?? []) {
      if (threat.hash && fullHashSet.has(threat.hash)) {
        for (const threatType of threat.threatTypes ?? []) {
          if (
            (WEB_RISK_THREAT_TYPES as readonly string[]).includes(threatType)
          ) {
            confirmedThreatTypes.add(threatType);
          }
        }
      }
    }
  }

  const categories = [...confirmedThreatTypes] as WebRiskThreatType[];
  return {
    provider: PROVIDER,
    // No confirmed full-hash match = prefix collision = clean.
    riskScore: categories.length > 0 ? 100 : 0,
    categories,
    fromCache: false,
    raw: {
      localPrefixMatch: true,
      prefixesSearched: uniquePrefixes.size,
      threats: responses.flatMap(response =>
        (response.threats ?? []).map(threat => ({
          hash: threat.hash,
          threatTypes: threat.threatTypes,
        })),
      ),
    },
  };
}

/** Await a promise, rejecting early if the signal aborts. */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new Error("Web Risk lookup aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Web Risk lookup aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
