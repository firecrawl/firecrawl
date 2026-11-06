import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

const VERSION = "v1";
const MAX_AGE_SEC = 24 * 60 * 60;
const CLOCK_SKEW_SEC = 60;
const SIGNATURE_BYTES = 16;
/** The longest token feedback accepts; a call whose token would be longer gets none. */
export const MAX_FEEDBACK_TOKEN_LENGTH = 1024;

export type FeedbackTokenClaims = {
  requestId: string;
  provider: string;
  capability: string;
  issuedAt: number;
};

/** Domain-separated so the token key never equals the Exchange caller secret. */
function signingKey(): Buffer | null {
  const secret = config.EXCHANGE_INTERNAL_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update("alexandria-feedback-token:v1")
    .digest();
}

// The team is signed but not carried, so a token only verifies for its own team.
const sign = (key: Buffer, payload: string, teamId: string) =>
  createHmac("sha256", key)
    .update(`${VERSION}.${payload}.${teamId}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES);

/**
 * A token naming one Alexandria provider call, so feedback can prove which
 * calls it rates. Returns undefined without a signing key or when the token
 * would exceed MAX_FEEDBACK_TOKEN_LENGTH.
 * Callers must not issue tokens under zero data retention.
 */
export function issueFeedbackToken(
  claims: Omit<FeedbackTokenClaims, "issuedAt"> & { teamId: string },
  now = Date.now(),
): string | undefined {
  const key = signingKey();
  if (!key) return undefined;
  const payload = Buffer.from(
    JSON.stringify([
      claims.requestId,
      claims.provider,
      claims.capability,
      Math.floor(now / 1000),
    ]),
  ).toString("base64url");
  const token = `${VERSION}.${payload}.${sign(key, payload, claims.teamId).toString("base64url")}`;
  return token.length <= MAX_FEEDBACK_TOKEN_LENGTH ? token : undefined;
}

/** The token's claims if it was issued to teamId, its signature holds and it is under 24 hours old; otherwise null. */
export function verifyFeedbackToken(
  token: string,
  teamId: string,
  now = Date.now(),
): FeedbackTokenClaims | null {
  const key = signingKey();
  if (!key) return null;
  const [version, payload, signature, ...rest] = token.split(".");
  if (version !== VERSION || !payload || !signature || rest.length > 0)
    return null;
  const expected = sign(key, payload, teamId);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(fields) || fields.length !== 4) return null;
  const [requestId, provider, capability, issuedAt] = fields;
  if (
    typeof requestId !== "string" ||
    typeof provider !== "string" ||
    typeof capability !== "string" ||
    typeof issuedAt !== "number" ||
    !Number.isInteger(issuedAt)
  )
    return null;
  const age = now / 1000 - issuedAt;
  if (age > MAX_AGE_SEC || age < -CLOCK_SKEW_SEC) return null;
  return { requestId, provider, capability, issuedAt };
}
