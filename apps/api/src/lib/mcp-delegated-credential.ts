import { createHmac, timingSafeEqual } from "crypto";
import { isValidUuid } from "./owner-id";
import { parseApi } from "./parseApi";

const PREFIX = "fcmcp_";
const MAX_TOKEN_LENGTH = 2_048;
const MAX_FUTURE_IAT_SECONDS = 30;
const MAX_FUTURE_EXP_SECONDS = 120;

type McpDelegatedCredential = {
  v: 1;
  aud: "firecrawl-core";
  purpose: "hosted_mcp_oauth";
  api_key: string;
  iat: number;
  exp: number;
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

function isExactPayload(value: unknown): value is McpDelegatedCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  if (keys.length !== 6 || keys.join(",") !== "api_key,aud,exp,iat,purpose,v") {
    return false;
  }

  if (
    payload.v !== 1 ||
    payload.aud !== "firecrawl-core" ||
    payload.purpose !== "hosted_mcp_oauth" ||
    typeof payload.api_key !== "string" ||
    !/^fc-[0-9a-f]{32}$/i.test(payload.api_key) ||
    !isValidUuid(parseApi(payload.api_key)) ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp)
  ) {
    return false;
  }

  return true;
}

export function verifyMcpDelegatedCredential(
  token: string,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): McpDelegatedCredential | null {
  if (!secret || token.length > MAX_TOKEN_LENGTH || !token.startsWith(PREFIX)) {
    return null;
  }

  const encoded = token.slice(PREFIX.length);
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

  if (!isExactPayload(payload)) return null;
  if (payload.iat > nowSeconds + MAX_FUTURE_IAT_SECONDS) return null;
  if (
    payload.exp <= nowSeconds ||
    payload.exp > nowSeconds + MAX_FUTURE_EXP_SECONDS
  ) {
    return null;
  }
  if (payload.exp <= payload.iat || payload.exp - payload.iat > 120)
    return null;

  return payload;
}
