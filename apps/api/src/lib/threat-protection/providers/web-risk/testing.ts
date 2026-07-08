import { createHash } from "crypto";
import type http from "http";
import { generateUrlExpressions } from "./canonicalize";
import { WEB_RISK_THREAT_TYPES, type WebRiskThreatType } from "./store";

// Test helpers for the Web Risk Update API provider — shared by the unit
// suites in this directory and the threat-protection snips (which mock the
// Google endpoints with a local HTTP server). Not used in production code.
// NOTE: the fake Redis lives in ./fake-redis.ts (imported by vi.mock
// factories, which must not transitively import services/queue-service).

export { createFakeWebRiskRedis } from "./fake-redis";

export function sha256(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * SHA-256 of the exact (most-specific) lookup expression for a URL or bare
 * domain — index 0 of the expression list is always exact host + exact path
 * (+ query); for a bare domain that is `host/`.
 */
export function urlExpressionHash(url: string): Buffer {
  return sha256(generateUrlExpressions(url)[0]);
}

/**
 * In-memory model of Google's threat lists, able to answer both mocked
 * endpoints: threatLists:computeDiff (always a full RESET of the current
 * state — exactly what a fresh syncer needs) and hashes:search.
 */
export class WebRiskMockDatabase {
  private fullHashesByType = new Map<WebRiskThreatType, Buffer[]>();
  /** Entries in the list with no confirmable full hash (collision cases). */
  private prefixOnlyByType = new Map<WebRiskThreatType, Buffer[]>();

  /**
   * Flags a whole domain: its exact-host expression hash (`host/`) joins the
   * list, so every URL on the domain matches via the host-suffix expressions.
   */
  addRiskyDomain(
    domain: string,
    threatType: WebRiskThreatType = "MALWARE",
  ): void {
    this.addFullHash(urlExpressionHash(domain), threatType);
  }

  /**
   * Flags a single URL: only its exact expression (host + path + query) joins
   * the list — other URLs on the same domain stay clean, which is what makes
   * checks URL-level rather than domain-level.
   */
  addRiskyUrl(url: string, threatType: WebRiskThreatType = "MALWARE"): void {
    this.addFullHash(urlExpressionHash(url), threatType);
  }

  addFullHash(fullHash: Buffer, threatType: WebRiskThreatType): void {
    const hashes = this.fullHashesByType.get(threatType) ?? [];
    hashes.push(fullHash);
    this.fullHashesByType.set(threatType, hashes);
  }

  /**
   * Puts only a 4-byte prefix in the list, whose hashes:search confirmation
   * returns a full hash that does NOT match the caller's expression (i.e. a
   * prefix collision): pass the full hash of some *other* expression that
   * shares the target's 4-byte prefix.
   */
  addCollidingFullHash(fullHash: Buffer, threatType: WebRiskThreatType): void {
    const hashes = this.prefixOnlyByType.get(threatType) ?? [];
    hashes.push(fullHash);
    this.prefixOnlyByType.set(threatType, hashes);
  }

  private entriesFor(threatType: WebRiskThreatType): Buffer[] {
    const prefixes = [
      ...(this.fullHashesByType.get(threatType) ?? []),
      ...(this.prefixOnlyByType.get(threatType) ?? []),
    ].map(hash => hash.subarray(0, 4));
    const unique = new Map(prefixes.map(p => [p.toString("hex"), p]));
    return [...unique.values()].sort(Buffer.compare);
  }

  /** RESET response body for a threatLists:computeDiff request. */
  computeDiffResponse(threatType: string): object {
    const entries = this.entriesFor(threatType as WebRiskThreatType);
    const checksum = createHash("sha256");
    for (const entry of entries) checksum.update(entry);
    return {
      responseType: "RESET",
      additions:
        entries.length > 0
          ? {
              rawHashes: [
                {
                  prefixSize: 4,
                  rawHashes: Buffer.concat(entries).toString("base64"),
                },
              ],
            }
          : undefined,
      newVersionToken: Buffer.from(
        `token-${threatType}-${Date.now()}`,
      ).toString("base64"),
      checksum: { sha256: checksum.digest("base64") },
      recommendedNextDiff: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
  }

  /** Response body for a hashes:search request. */
  hashesSearchResponse(hashPrefixBase64: string): object {
    const prefix = Buffer.from(hashPrefixBase64, "base64");
    const threats: object[] = [];
    for (const threatType of WEB_RISK_THREAT_TYPES) {
      const candidates = [
        ...(this.fullHashesByType.get(threatType) ?? []),
        ...(this.prefixOnlyByType.get(threatType) ?? []),
      ];
      for (const fullHash of candidates) {
        if (
          prefix.length <= fullHash.length &&
          fullHash.subarray(0, prefix.length).equals(prefix)
        ) {
          threats.push({
            hash: fullHash.toString("base64"),
            threatTypes: [threatType],
            expireTime: new Date(Date.now() + 3600_000).toISOString(),
          });
        }
      }
    }
    return {
      ...(threats.length > 0 ? { threats } : {}),
      negativeExpireTime: new Date(Date.now() + 3600_000).toISOString(),
    };
  }
}

interface WebRiskMockCounters {
  computeDiffRequests: number;
  hashesSearchRequests: number;
  /** hashes:search requests per 4-byte prefix (hex). */
  hashesSearchByPrefixHex: Map<string, number>;
  /** hashes:search confirmations for a URL's/domain's exact expression. */
  hashesSearchRequestsForTarget(urlOrDomain: string): number;
}

/**
 * HTTP handler for the two mocked Web Risk endpoints. Returns true when the
 * request was handled (so callers can chain their own routes).
 */
export function createWebRiskMockHandler(
  db: WebRiskMockDatabase,
  counters: WebRiskMockCounters,
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/v1/threatLists:computeDiff") {
      counters.computeDiffRequests++;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          db.computeDiffResponse(url.searchParams.get("threatType") ?? ""),
        ),
      );
      return true;
    }
    if (url.pathname === "/v1/hashes:search") {
      counters.hashesSearchRequests++;
      const prefixB64 = url.searchParams.get("hashPrefix") ?? "";
      const prefixHex = Buffer.from(prefixB64, "base64").toString("hex");
      counters.hashesSearchByPrefixHex.set(
        prefixHex,
        (counters.hashesSearchByPrefixHex.get(prefixHex) ?? 0) + 1,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(db.hashesSearchResponse(prefixB64)));
      return true;
    }
    return false;
  };
}

export function createWebRiskMockCounters(): WebRiskMockCounters {
  const counters: WebRiskMockCounters = {
    computeDiffRequests: 0,
    hashesSearchRequests: 0,
    hashesSearchByPrefixHex: new Map(),
    hashesSearchRequestsForTarget(urlOrDomain: string): number {
      const prefixHex = urlExpressionHash(urlOrDomain)
        .subarray(0, 4)
        .toString("hex");
      return counters.hashesSearchByPrefixHex.get(prefixHex) ?? 0;
    },
  };
  return counters;
}
