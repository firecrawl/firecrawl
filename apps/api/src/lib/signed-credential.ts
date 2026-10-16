import { createHmac, timingSafeEqual } from "crypto";
import { isValidUuid } from "./owner-id";
import { parseApi } from "./parseApi";

const MAX_TOKEN_LENGTH = 2_048;
const MAX_FUTURE_IAT_SECONDS = 30;

type Claims = { aud: "firecrawl-core"; iat: number; exp: number };

type McpDelegation = Claims & { purpose: "hosted_mcp_oauth" } & (
    | { v: 1; api_key: string }
    | { v: 2; api_key_id: number; grant_id: string }
  );

type TeamToken = Claims & {
  v: 1;
  team_id: string;
  api_key_id: number | null;
};

type SignedCredential<T extends Claims> = {
  prefix: string;
  maxTtlSeconds: number;
  // Checks everything but aud, iat and exp, which the verifier checks itself.
  isPayload: (payload: Record<string, unknown>) => boolean;
};

const hasKeys = (payload: Record<string, unknown>, sortedKeys: string) =>
  Object.keys(payload).sort().join(",") === sortedKeys;

const isApiKeyId = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0;

export const MCP_DELEGATION: SignedCredential<McpDelegation> = {
  prefix: "fcmcp_",
  maxTtlSeconds: 120,
  isPayload: payload =>
    payload.purpose === "hosted_mcp_oauth" &&
    ((hasKeys(payload, "api_key,aud,exp,iat,purpose,v") &&
      payload.v === 1 &&
      typeof payload.api_key === "string" &&
      /^fc-[0-9a-f]{32}$/i.test(payload.api_key) &&
      isValidUuid(parseApi(payload.api_key))) ||
      (hasKeys(payload, "api_key_id,aud,exp,grant_id,iat,purpose,v") &&
        payload.v === 2 &&
        isApiKeyId(payload.api_key_id) &&
        typeof payload.grant_id === "string" &&
        isValidUuid(payload.grant_id))),
};

export const TEAM_TOKEN: SignedCredential<TeamToken> = {
  prefix: "fct_",
  maxTtlSeconds: 300,
  isPayload: payload =>
    hasKeys(payload, "api_key_id,aud,exp,iat,team_id,v") &&
    payload.v === 1 &&
    typeof payload.team_id === "string" &&
    isValidUuid(payload.team_id) &&
    (payload.api_key_id === null || isApiKeyId(payload.api_key_id)),
};

function decodeCanonicalBase64Url(segment: string): Buffer | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;

  try {
    const decoded = Buffer.from(segment, "base64url");
    return decoded.toString("base64url") === segment ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Verifies `<prefix><base64url JSON payload>.<base64url HMAC-SHA256 of the
 * payload segment>` and returns the payload, or null for anything malformed,
 * unsigned, expired, or living longer than the credential's max TTL.
 */
export function verifySignedCredential<T extends Claims>(
  token: string,
  credential: SignedCredential<T>,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): T | null {
  const { prefix, maxTtlSeconds } = credential;
  if (!secret || token.length > MAX_TOKEN_LENGTH || !token.startsWith(prefix)) {
    return null;
  }

  const encoded = token.slice(prefix.length);
  const separator = encoded.indexOf(".");
  if (separator <= 0 || separator !== encoded.lastIndexOf(".")) return null;

  const payloadSegment = encoded.slice(0, separator);
  const signatureSegment = encoded.slice(separator + 1);
  const payloadBytes = decodeCanonicalBase64Url(payloadSegment);
  const signature = decodeCanonicalBase64Url(signatureSegment);
  if (!payloadBytes || !signature || signature.length !== 32) return null;

  const expected = createHmac("sha256", secret).update(payloadSegment).digest();
  if (!timingSafeEqual(signature, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
    );
  } catch {
    return null;
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const claims = payload as Record<string, unknown>;
  if (
    claims.aud !== "firecrawl-core" ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    !credential.isPayload(claims)
  ) {
    return null;
  }

  const { iat, exp } = claims as T;
  if (iat > nowSeconds + MAX_FUTURE_IAT_SECONDS) return null;
  if (exp <= nowSeconds || exp <= iat || exp - iat > maxTtlSeconds) return null;

  return claims as T;
}
