import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { config } from "../../config";
import {
  mintWorldIdCredential,
  openDeviceHandle,
  pollWorldIdDeviceFlow,
  sealDeviceCode,
  startWorldIdDeviceFlow,
  verifyWorldIdCredential,
  worldIdSubjectHash,
} from "../world-id";

const ISSUER = "https://issuer.test";
const CLIENT_ID = "app_test";
const ORB_ACR = "https://world.org/oidc/acr/orb-v3";

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
});

beforeEach(() => {
  config.WORLD_ID_ISSUER = ISSUER;
  config.WORLD_ID_CLIENT_ID = CLIENT_ID;
  config.WORLD_ID_CLIENT_SECRET = "client-secret";
  config.WORLD_ID_CREDENTIAL_SECRET = "c".repeat(32);
  config.WORLD_ID_ALLOWED_SUBJECTS = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function idToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({ acr: ORB_ACR, amr: ["pop"], ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("human-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/** Fakes the issuer: its JWKS, plus the given token endpoint response. */
function stubIssuer(token: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === `${ISSUER}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (href === `${ISSUER}/api/v1/token`) {
      return new Response(JSON.stringify(token.body), {
        status: token.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (href === `${ISSUER}/api/v1/device_authorization`) {
      return new Response(
        JSON.stringify({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: `${ISSUER}/device`,
          verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
          expires_in: 1200,
          interval: 5,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${href} ${init?.method}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("World ID credential", () => {
  // The subject hash is keyed by config, which beforeEach sets.
  let hash: string;
  beforeEach(() => {
    hash = worldIdSubjectHash(ISSUER, "human-1");
  });

  it("verifies a credential it minted and returns the subject hash", () => {
    const { credential } = mintWorldIdCredential(hash);
    expect(credential.startsWith("fcwid_")).toBe(true);
    expect(verifyWorldIdCredential(credential)).toBe(hash);
  });

  it("rejects expired, tampered, foreign-key and malformed credentials", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = mintWorldIdCredential(hash, now - 31 * 86400).credential;
    expect(verifyWorldIdCredential(expired, now)).toBeNull();

    const { credential } = mintWorldIdCredential(hash);
    const [payload, signature] = credential.slice(6).split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, sub: "x".repeat(43), iat: now, exp: now + 60 }),
    ).toString("base64url");
    expect(verifyWorldIdCredential(`fcwid_${forged}.${signature}`)).toBeNull();

    const otherKey = createHmac("sha256", "d".repeat(32))
      .update(payload)
      .digest("base64url");
    expect(verifyWorldIdCredential(`fcwid_${payload}.${otherKey}`)).toBeNull();

    for (const bad of [
      undefined,
      42,
      "",
      "fcwid_",
      "fcmcp_a.b",
      `${credential}.x`,
    ]) {
      expect(verifyWorldIdCredential(bad)).toBeNull();
    }
  });

  it("ignores every credential while World ID is not configured", () => {
    const { credential } = mintWorldIdCredential(hash);
    config.WORLD_ID_CLIENT_SECRET = undefined;
    expect(verifyWorldIdCredential(credential)).toBeNull();
  });
});

describe("device handle", () => {
  it("round-trips the device code and rejects a tampered handle", () => {
    const handle = sealDeviceCode("device-secret");
    expect(handle).not.toContain("device-secret");
    expect(openDeviceHandle(handle)).toBe("device-secret");

    const bytes = Buffer.from(handle, "base64url");
    bytes[bytes.length - 1] ^= 1;
    expect(openDeviceHandle(bytes.toString("base64url"))).toBeNull();
    expect(openDeviceHandle("not a handle")).toBeNull();
  });
});

describe("device flow", () => {
  it("starts with the client credentials and hides the device code", async () => {
    const fetchMock = stubIssuer({ status: 400, body: {} });
    const start = await startWorldIdDeviceFlow();

    expect(start).toMatchObject({
      ok: true,
      userCode: "ABCD-EFGH",
      expiresIn: 1200,
      interval: 5,
    });
    if (!start.ok) throw new Error("expected a start");
    expect(openDeviceHandle(start.deviceHandle)).toBe("device-secret");

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBe("scope=openid");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("app_test:client-secret").toString("base64")}`,
    );
  });

  it("mints a credential for a valid Orb-verified ID token", async () => {
    stubIssuer({
      status: 200,
      body: { id_token: await idToken({ auth_time: 1 }) },
    });
    const result = await pollWorldIdDeviceFlow(sealDeviceCode("device-secret"));

    expect(result.outcome).toBe("approved");
    if (result.outcome !== "approved") throw new Error("expected approval");
    expect(verifyWorldIdCredential(result.credential)).toBe(
      worldIdSubjectHash(ISSUER, "human-1"),
    );
  });

  it("refuses an ID token without the Orb authentication class", async () => {
    stubIssuer({
      status: 200,
      body: { id_token: await idToken({ auth_time: 1, acr: "other" }) },
    });
    expect(
      await pollWorldIdDeviceFlow(sealDeviceCode("device-secret")),
    ).toEqual({ outcome: "error", status: 400, error: "invalid_grant" });
  });

  it("issues credentials only to allowed subjects when the allowlist is set", async () => {
    config.WORLD_ID_ALLOWED_SUBJECTS = "someone-else";
    stubIssuer({
      status: 200,
      body: { id_token: await idToken({ auth_time: 1 }) },
    });
    expect(
      await pollWorldIdDeviceFlow(sealDeviceCode("device-secret")),
    ).toEqual({
      outcome: "not_allowed",
      subjectHash: worldIdSubjectHash(ISSUER, "human-1"),
    });
  });

  it("passes pending and terminal poll errors through", async () => {
    stubIssuer({ status: 400, body: { error: "authorization_pending" } });
    expect(
      await pollWorldIdDeviceFlow(sealDeviceCode("device-secret")),
    ).toEqual({
      outcome: "error",
      status: 400,
      error: "authorization_pending",
    });

    expect(await pollWorldIdDeviceFlow("forged")).toEqual({
      outcome: "error",
      status: 400,
      error: "invalid_request",
    });
  });
});
