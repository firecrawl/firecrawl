import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config";

// World ID verified-human keyless bucket.
//
// World ID ID tokens are short-lived and come without a refresh token, so they
// can't ride along on every keyless request. Instead the API runs the OIDC
// device flow on the caller's behalf (the client secret and the device code
// stay server-side), validates the ID token once, and mints its own `fcwid_`
// credential, which keyless requests send in `x-firecrawl-world-id`. The
// credential carries only a keyed hash of the World ID subject.

const CREDENTIAL_PREFIX = "fcwid_";
const CREDENTIAL_TTL_SECONDS = 30 * 86400;
const MAX_CREDENTIAL_LENGTH = 512;
const MAX_FUTURE_IAT_SECONDS = 30;
const MAX_DEVICE_HANDLE_LENGTH = 2_048;
const SUBJECT_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ORB_ACR = "https://world.org/oidc/acr/orb-v3";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT_MS = 10_000;

export function isWorldIdConfigured(): boolean {
  return Boolean(
    config.WORLD_ID_ISSUER &&
      config.WORLD_ID_CLIENT_ID &&
      config.WORLD_ID_CLIENT_SECRET &&
      config.WORLD_ID_CREDENTIAL_SECRET,
  );
}

function issuer(): string {
  return config.WORLD_ID_ISSUER!.replace(/\/+$/, "");
}

// One key per purpose, all derived from WORLD_ID_CREDENTIAL_SECRET.
function derivedKey(purpose: string): Buffer {
  return createHmac("sha256", config.WORLD_ID_CREDENTIAL_SECRET!)
    .update(`world-id:${purpose}`)
    .digest();
}

function decodeCanonicalBase64Url(segment: string): Buffer | null {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const decoded = Buffer.from(segment, "base64url");
  return decoded.toString("base64url") === segment ? decoded : null;
}

/** Keyed, stable pseudonym for a World ID account: the only form we keep. */
export function worldIdSubjectHash(iss: string, sub: string): string {
  return createHmac("sha256", derivedKey("subject"))
    .update(`${iss}\n${sub}`)
    .digest("base64url");
}

export function isWorldIdSubjectAllowed(subjectHash: string): boolean {
  const allowed = config.WORLD_ID_ALLOWED_SUBJECTS;
  if (!allowed) return true;
  return allowed
    .split(",")
    .map(entry => entry.trim())
    .includes(subjectHash);
}

export function mintWorldIdCredential(
  subjectHash: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { credential: string; expiresAt: number } {
  const expiresAt = nowSeconds + CREDENTIAL_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, sub: subjectHash, iat: nowSeconds, exp: expiresAt }),
  ).toString("base64url");
  const signature = createHmac("sha256", derivedKey("credential"))
    .update(payload)
    .digest("base64url");
  return {
    credential: `${CREDENTIAL_PREFIX}${payload}.${signature}`,
    expiresAt,
  };
}

/**
 * The subject hash a valid, unexpired `fcwid_` credential carries, or null.
 * Always null while World ID is not configured, so the header is ignored.
 */
export function verifyWorldIdCredential(
  token: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (
    !isWorldIdConfigured() ||
    typeof token !== "string" ||
    token.length > MAX_CREDENTIAL_LENGTH ||
    !token.startsWith(CREDENTIAL_PREFIX)
  ) {
    return null;
  }

  const [payloadSegment, signatureSegment, ...rest] = token
    .slice(CREDENTIAL_PREFIX.length)
    .split(".");
  if (rest.length > 0 || !payloadSegment || !signatureSegment) return null;
  const payloadBytes = decodeCanonicalBase64Url(payloadSegment);
  const signature = decodeCanonicalBase64Url(signatureSegment);
  if (!payloadBytes || !signature || signature.length !== 32) return null;

  const expected = createHmac("sha256", derivedKey("credential"))
    .update(payloadSegment)
    .digest();
  if (!timingSafeEqual(signature, expected)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Object.keys(payload).sort().join(",") !== "exp,iat,sub,v" ||
    payload.v !== 1 ||
    typeof payload.sub !== "string" ||
    !SUBJECT_HASH_PATTERN.test(payload.sub) ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp)
  ) {
    return null;
  }
  const iat = payload.iat as number;
  const exp = payload.exp as number;
  if (iat > nowSeconds + MAX_FUTURE_IAT_SECONDS) return null;
  if (exp <= nowSeconds || exp - iat > CREDENTIAL_TTL_SECONDS) return null;
  return payload.sub;
}

// The device code must stay out of client hands (whoever holds it can redeem
// the approval with our client credentials), so the client polls with an
// encrypted handle instead and the API needs no state between calls.
export function sealDeviceCode(deviceCode: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey("device"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(deviceCode, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}

export function openDeviceHandle(handle: unknown): string | null {
  if (typeof handle !== "string" || handle.length > MAX_DEVICE_HANDLE_LENGTH) {
    return null;
  }
  const bytes = decodeCanonicalBase64Url(handle);
  if (!bytes || bytes.length <= 28) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derivedKey("device"),
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// CEILING: endpoint paths are fixed rather than read from the issuer's
// discovery document; they are the same on every World ID issuer today. Read
// `.well-known/openid-configuration` if an issuer ever differs.
let jwks: {
  issuer: string;
  set: ReturnType<typeof createRemoteJWKSet>;
} | null = null;

function issuerJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks?.issuer !== issuer()) {
    jwks = {
      issuer: issuer(),
      set: createRemoteJWKSet(new URL(`${issuer()}/.well-known/jwks.json`)),
    };
  }
  return jwks.set;
}

async function postToIssuer(
  path: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const basic = Buffer.from(
    `${encodeURIComponent(config.WORLD_ID_CLIENT_ID!)}:${encodeURIComponent(
      config.WORLD_ID_CLIENT_SECRET!,
    )}`,
  ).toString("base64");
  const res = await fetch(`${issuer()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    // Non-JSON bodies are handled by status.
  }
  return { status: res.status, body };
}

export type WorldIdDeviceStart =
  | {
      ok: true;
      deviceHandle: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number;
      interval: number;
    }
  | { ok: false; status: number; error: string };

export async function startWorldIdDeviceFlow(): Promise<WorldIdDeviceStart> {
  let res: Awaited<ReturnType<typeof postToIssuer>>;
  try {
    res = await postToIssuer("/api/v1/device_authorization", {
      scope: "openid",
    });
  } catch {
    return { ok: false, status: 502, error: "temporarily_unavailable" };
  }
  const { body } = res;
  if (
    res.status !== 200 ||
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    return res.status === 429
      ? { ok: false, status: 429, error: "slow_down" }
      : { ok: false, status: 502, error: "temporarily_unavailable" };
  }
  return {
    ok: true,
    deviceHandle: sealDeviceCode(body.device_code),
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    ...(typeof body.verification_uri_complete === "string"
      ? { verificationUriComplete: body.verification_uri_complete }
      : {}),
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 1200,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

export type WorldIdDevicePoll =
  | { outcome: "approved"; credential: string; expiresAt: number }
  | { outcome: "not_allowed"; subjectHash: string }
  | { outcome: "error"; status: number; error: string };

/** Validates a World ID ID token and returns its subject hash, or null. */
export async function verifyWorldIdIdToken(
  idToken: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(idToken, issuerJwks(), {
      issuer: issuer(),
      audience: config.WORLD_ID_CLIENT_ID!,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "auth_time"],
    });
    if (payload.acr !== ORB_ACR || typeof payload.sub !== "string") {
      return null;
    }
    return worldIdSubjectHash(issuer(), payload.sub);
  } catch {
    return null;
  }
}

export async function pollWorldIdDeviceFlow(
  deviceHandle: unknown,
): Promise<WorldIdDevicePoll> {
  const deviceCode = openDeviceHandle(deviceHandle);
  if (!deviceCode) {
    return { outcome: "error", status: 400, error: "invalid_request" };
  }

  let res: Awaited<ReturnType<typeof postToIssuer>>;
  try {
    res = await postToIssuer("/api/v1/token", {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
    });
  } catch {
    return { outcome: "error", status: 502, error: "temporarily_unavailable" };
  }

  if (res.status === 200 && typeof res.body.id_token === "string") {
    const subjectHash = await verifyWorldIdIdToken(res.body.id_token);
    if (!subjectHash) {
      return { outcome: "error", status: 400, error: "invalid_grant" };
    }
    if (!isWorldIdSubjectAllowed(subjectHash)) {
      return { outcome: "not_allowed", subjectHash };
    }
    return { outcome: "approved", ...mintWorldIdCredential(subjectHash) };
  }

  // RFC 8628 poll errors pass through so the client can follow its stop rules
  // (authorization_pending and slow_down keep polling, the rest stop).
  if (res.status === 400 && typeof res.body.error === "string") {
    return { outcome: "error", status: 400, error: res.body.error };
  }
  return { outcome: "error", status: 502, error: "temporarily_unavailable" };
}
