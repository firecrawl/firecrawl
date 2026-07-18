import { logger } from "../lib/logger";
import {
  getOAuthTokenCacheState,
  hashOAuthToken,
  isOAuthTokenRevoked,
  setOAuthTokenCache,
} from "./oauth-token-cache";

const ACTIVE_CACHE_TTL_SECONDS = 300;
const INACTIVE_CACHE_TTL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 10_000;

export const FIRECRAWL_REST_RESOURCE = "https://api.firecrawl.dev/";

export interface OAuthIntrospectionResponse {
  active: boolean;
  api_key: string;
  scope: string;
  client_id: string;
  team_id: string;
  exp: number;
  aud?: string | null;
}

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function hasExpectedAudience(
  audience: string | null | undefined,
  expectedResource: string,
): boolean {
  if (audience != null) return audience === expectedResource;
  return expectedResource === FIRECRAWL_REST_RESOURCE;
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
  const tokenHash = hashOAuthToken(token);
  const cache = await getOAuthTokenCacheState(tokenHash);
  if (cache.revoked) return null;
  if (cache.cached !== null) {
    try {
      const parsed = JSON.parse(cache.cached) as OAuthIntrospectionResponse;
      if (parsed.active !== true) return null;
      if (
        !Number.isFinite(parsed.exp) ||
        parsed.exp <= Math.floor(Date.now() / 1000)
      ) {
        return null;
      }
      // Tokens minted before resource indicators have no audience. That legacy
      // compatibility applies only to the original REST resource; MCP resources
      // always require an explicit, exact audience.
      if (!hasExpectedAudience(parsed.aud, options.expectedResource)) {
        return null;
      }
      return (await isOAuthTokenRevoked(tokenHash)) ? null : parsed;
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
      return null;
    }

    const data = (await response.json()) as OAuthIntrospectionResponse;
    if (await isOAuthTokenRevoked(tokenHash)) return null;

    if (data.active !== true) {
      await setOAuthTokenCache(
        tokenHash,
        JSON.stringify({ active: false }),
        INACTIVE_CACHE_TTL_SECONDS,
      );
      return null;
    }

    if (!hasExpectedAudience(data.aud, options.expectedResource)) {
      logger.warn(
        "OAuth introspection audience did not match expected resource",
      );
      return null;
    }

    if (!Number.isFinite(data.exp)) return null;
    const remainingSeconds = Math.max(
      0,
      data.exp - Math.floor(Date.now() / 1000),
    );
    if (remainingSeconds <= 0) return null;
    await setOAuthTokenCache(
      tokenHash,
      JSON.stringify(data),
      Math.min(remainingSeconds, ACTIVE_CACHE_TTL_SECONDS),
    );
    return data;
  } catch (error) {
    logger.error("OAuth introspection error", { error });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
