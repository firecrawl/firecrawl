import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import { getValue, setValue } from "./redis";

const INACTIVE_CACHE_TTL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 10_000;

export const FIRECRAWL_REST_RESOURCE = "https://api.firecrawl.dev/";

export class OAuthIntrospectionUnavailableError extends Error {
  constructor(message = "OAuth introspection is temporarily unavailable") {
    super(message);
    this.name = "OAuthIntrospectionUnavailableError";
  }
}

export interface OAuthIntrospectionResponse {
  active: boolean;
  api_key: string;
  scope: string;
  client_id: string;
  team_id: string;
  exp: number;
  aud?: string | null;
  credential_purpose?: "general" | "hosted_mcp_oauth";
}

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function cacheKey(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex");
  return `oauth_token:${hash.slice(0, 32)}`;
}

function hasValidCredentialPurpose(data: OAuthIntrospectionResponse): boolean {
  const purpose = (data as { credential_purpose?: unknown }).credential_purpose;
  return (
    purpose === undefined ||
    purpose === "general" ||
    purpose === "hosted_mcp_oauth"
  );
}

async function writeCache(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await setValue(key, value, ttlSeconds);
  } catch (error) {
    // Introspection remains authoritative. A cache outage must not turn a
    // valid credential into an authentication outage.
    logger.warn("OAuth introspection cache write failed", { error });
  }
}

function hasExpectedAudience(
  data: OAuthIntrospectionResponse,
  expectedResource: string,
): boolean {
  if (data.aud != null) return data.aud === expectedResource;
  return (
    expectedResource === FIRECRAWL_REST_RESOURCE &&
    data.credential_purpose !== "hosted_mcp_oauth"
  );
}

function isUsable(
  data: OAuthIntrospectionResponse,
  expectedResource: string,
): boolean {
  return (
    data.active === true &&
    Number.isFinite(data.exp) &&
    data.exp > Math.floor(Date.now() / 1000) &&
    hasExpectedAudience(data, expectedResource)
  );
}

function isValidActiveResponse(data: OAuthIntrospectionResponse): boolean {
  return (
    data.active === true &&
    typeof data.api_key === "string" &&
    /^fc-[0-9a-f]{32}$/i.test(data.api_key) &&
    typeof data.scope === "string" &&
    typeof data.client_id === "string" &&
    data.client_id.length > 0 &&
    typeof data.team_id === "string" &&
    data.team_id.length > 0 &&
    hasValidCredentialPurpose(data) &&
    Number.isFinite(data.exp)
  );
}

export async function resolveOAuthToken(
  token: string,
  options: {
    introspectUrl: string;
    introspectSecret: string;
    expectedResource: string;
    fetchFn?: Fetch;
    timeoutMs?: number;
  },
): Promise<OAuthIntrospectionResponse | null> {
  const key = cacheKey(token);
  let cached: string | null = null;
  try {
    cached = await getValue(key);
  } catch (error) {
    // Treat Redis as an optimization: bypass it and use live introspection.
    logger.warn("OAuth introspection cache read failed", { error });
  }
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached) as OAuthIntrospectionResponse;
      if (parsed.active !== true) return null;
      // Active OAuth credentials are always resolved live so revocation,
      // membership loss, and refresh-token reuse take effect immediately.
    } catch {
      // Corrupt cache entries are treated as misses.
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  timeout.unref?.();

  try {
    const response = await (options.fetchFn ?? fetch)(options.introspectUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.introspectSecret}`,
      },
      body: JSON.stringify({ token, resource: options.expectedResource }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.error("OAuth introspection request failed", {
        status: response.status,
      });
      throw new OAuthIntrospectionUnavailableError();
    }

    const data = (await response.json()) as OAuthIntrospectionResponse;
    if (
      typeof data.active !== "boolean" ||
      (data.active === true && !isValidActiveResponse(data))
    ) {
      throw new OAuthIntrospectionUnavailableError(
        "OAuth introspection returned an invalid response",
      );
    }
    if (!isUsable(data, options.expectedResource)) {
      if (data.active !== true) {
        await writeCache(
          key,
          JSON.stringify({ active: false }),
          INACTIVE_CACHE_TTL_SECONDS,
        );
      }
      return null;
    }

    return data;
  } catch (error) {
    if (error instanceof OAuthIntrospectionUnavailableError) throw error;
    logger.error("OAuth introspection error", { error });
    throw new OAuthIntrospectionUnavailableError();
  } finally {
    clearTimeout(timeout);
  }
}
