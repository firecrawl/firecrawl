import type http from "http";
import type { ZscalerUrlCategory } from "./client";

// Mock ZIA server for tests: the Zidentity token endpoint plus the two ZIA
// endpoints the provider uses. Response shapes follow the official Zscaler
// SDK services (zscaler-sdk-go/py `urlcategories`), not hand-invented
// payloads. Point the API at it with:
//
//   ZSCALER_TOKEN_URL_OVERRIDE=http://localhost:<port>/oauth2/v1/token
//   ZSCALER_API_URL_OVERRIDE=http://localhost:<port>
//
// The urlLookup path then resolves to /zia/api/v1/urlLookup on this server.

export interface ZscalerMockDatabase {
  /** Credentials the token endpoint accepts. */
  clientId: string;
  clientSecret: string;
  /** Simulate a role without urlLookup access (View Only probe): 403. */
  denyLookupScope?: boolean;
  /** Simulate tenant-side throttling: every urlLookup call returns 429. */
  rateLimitLookups?: boolean;
  /** GET /urlCategories payload. */
  categories: ZscalerUrlCategory[];
  /**
   * POST /urlLookup classifications, keyed by the exact looked-up URL string
   * (schemeless). Unknown URLs return MISCELLANEOUS_OR_UNKNOWN, like ZIA.
   */
  classifications: Record<
    string,
    {
      urlClassifications: string[];
      urlClassificationsWithSecurityAlert: string[];
    }
  >;
}

interface ZscalerMockCounters {
  tokenCalls: number;
  categoriesCalls: number;
  lookupCalls: number;
  lookupUrls: number;
}

export function createZscalerMockCounters(): ZscalerMockCounters {
  return { tokenCalls: 0, categoriesCalls: 0, lookupCalls: 0, lookupUrls: 0 };
}

const MOCK_TOKEN = "mock-zscaler-access-token";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createZscalerMockHandler(
  db: ZscalerMockDatabase,
  counters: ZscalerMockCounters,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && url.pathname === "/oauth2/v1/token") {
        counters.tokenCalls++;
        const body = new URLSearchParams(await readBody(req));
        if (
          body.get("grant_type") !== "client_credentials" ||
          body.get("client_id") !== db.clientId ||
          body.get("client_secret") !== db.clientSecret
        ) {
          json(res, 401, { error: "invalid_client" });
          return;
        }
        json(res, 200, {
          access_token: MOCK_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }

      if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
        json(res, 401, { message: "Invalid or missing bearer token" });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/zia/api/v1/urlCategories"
      ) {
        counters.categoriesCalls++;
        json(res, 200, db.categories);
        return;
      }

      if (req.method === "POST" && url.pathname === "/zia/api/v1/urlLookup") {
        counters.lookupCalls++;
        if (db.denyLookupScope) {
          json(res, 403, { message: "Access to this resource is denied" });
          return;
        }
        if (db.rateLimitLookups) {
          res.setHeader("Retry-After", "1");
          json(res, 429, { message: "Rate limit exceeded" });
          return;
        }
        let urls: unknown;
        try {
          urls = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { message: "Invalid JSON body" });
          return;
        }
        if (
          !Array.isArray(urls) ||
          urls.length > 100 ||
          urls.some(entry => typeof entry !== "string" || entry.length > 1024)
        ) {
          json(res, 400, {
            message:
              "Expected an array of at most 100 URL strings of at most 1024 characters",
          });
          return;
        }
        counters.lookupUrls += urls.length;
        json(
          res,
          200,
          urls.map(lookupUrl => {
            const entry =
              typeof lookupUrl === "string"
                ? db.classifications[lookupUrl]
                : undefined;
            return {
              url: lookupUrl,
              urlClassifications: entry?.urlClassifications ?? [
                "MISCELLANEOUS_OR_UNKNOWN",
              ],
              urlClassificationsWithSecurityAlert:
                entry?.urlClassificationsWithSecurityAlert ?? [],
            };
          }),
        );
        return;
      }

      json(res, 404, { message: `No mock for ${req.method} ${url.pathname}` });
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  };
}
