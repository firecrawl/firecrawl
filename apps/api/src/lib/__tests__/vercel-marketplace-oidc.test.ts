import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import {
  createVercelJwks,
  looksLikeJwt,
  VercelJwksUnavailableError,
  VercelOidcTokenInvalidError,
  verifyVercelOidcToken,
} from "../vercel-marketplace-oidc";
import { logger } from "../logger";

const INTEGRATION_ID = "oac_test123";
const ISSUER = `https://integrations.vercel.com/${INTEGRATION_ID}`;
const JWKS_URL = `${ISSUER}/jwks.json`;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let signing: KeyPair;
let other: KeyPair;
let signingJwk: JWK;
let otherJwk: JWK;

beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  other = await generateKeyPair("RS256");
  signingJwk = {
    ...(await exportJWK(signing.publicKey)),
    kid: "k1",
    alg: "RS256",
  };
  otherJwk = { ...(await exportJWK(other.publicKey)), kid: "k2", alg: "RS256" };
});

function jwksResponse(keys: JWK[], cacheControl?: string) {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...(cacheControl ? { "Cache-Control": cacheControl } : {}),
    },
  });
}

async function sign(
  overrides: {
    claims?: Record<string, unknown>;
    aud?: string | string[];
    iss?: string;
    kid?: string;
    key?: KeyPair["privateKey"];
    alg?: string;
    expSecondsFromNow?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    resource: "res_1",
    owner: "team_abc",
    project: "prj_abc",
    environment: "production",
    ...overrides.claims,
  })
    .setProtectedHeader({
      alg: overrides.alg ?? "RS256",
      kid: overrides.kid ?? "k1",
    })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? "icfg_1")
    .setSubject("res_1")
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expSecondsFromNow ?? 300))
    .sign(overrides.key ?? signing.privateKey);
}

function staticJwks() {
  return createVercelJwks(JWKS_URL, {
    fetchFn: vi.fn().mockImplementation(async () => jwksResponse([signingJwk])),
  });
}

async function expectInvalid(token: string, getKey = staticJwks()) {
  await expect(
    verifyVercelOidcToken(token, { integrationId: INTEGRATION_ID, getKey }),
  ).rejects.toBeInstanceOf(VercelOidcTokenInvalidError);
}

describe("looksLikeJwt", () => {
  it("matches a three-segment token with a JSON header", async () => {
    expect(looksLikeJwt(await sign())).toBe(true);
  });

  it("does not match Firecrawl API keys or other bearer tokens", () => {
    expect(looksLikeJwt("fc-11111111111111118111111111111111")).toBe(false);
    expect(looksLikeJwt("11111111-1111-1111-8111-111111111111")).toBe(false);
    expect(looksLikeJwt("fco_access_token")).toBe(false);
    expect(looksLikeJwt("eyJhbGciOiJSUzI1NiJ9.onlytwo")).toBe(false);
  });
});

describe("verifyVercelOidcToken", () => {
  it("returns the claims of a valid resource token", async () => {
    const claims = await verifyVercelOidcToken(await sign(), {
      integrationId: INTEGRATION_ID,
      getKey: staticJwks(),
    });
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: "icfg_1",
      sub: "res_1",
      resource: "res_1",
      owner: "team_abc",
      project: "prj_abc",
      environment: "production",
    });
  });

  it("rejects a token from another integration", async () => {
    await expectInvalid(
      await sign({ iss: "https://integrations.vercel.com/oac_other" }),
    );
  });

  it("rejects a non-RS256 algorithm", async () => {
    const rs512 = await generateKeyPair("RS512");
    const jwk = { ...(await exportJWK(rs512.publicKey)), kid: "k3" };
    const getKey = createVercelJwks(JWKS_URL, {
      fetchFn: vi.fn().mockImplementation(async () => jwksResponse([jwk])),
    });
    await expectInvalid(
      await sign({ alg: "RS512", kid: "k3", key: rs512.privateKey }),
      getKey,
    );
  });

  it("rejects a token signed by a key outside the JWKS", async () => {
    await expectInvalid(await sign({ key: other.privateKey }));
  });

  it("rejects an expired token beyond the clock tolerance", async () => {
    await expectInvalid(await sign({ expSecondsFromNow: -120 }));
  });

  it("accepts a token within the 60s clock tolerance", async () => {
    await expect(
      verifyVercelOidcToken(await sign({ expSecondsFromNow: -30 }), {
        integrationId: INTEGRATION_ID,
        getKey: staticJwks(),
      }),
    ).resolves.toMatchObject({ resource: "res_1" });
  });

  it("rejects an aud that is not a single string", async () => {
    await expectInvalid(await sign({ aud: ["icfg_1", "icfg_2"] }));
  });

  it("rejects a token without a resource claim", async () => {
    await expectInvalid(await sign({ claims: { resource: undefined } }));
  });
});

describe("createVercelJwks", () => {
  it("caches keys for the Cache-Control max-age", async () => {
    let now = 1_000_000;
    const fetchFn = vi
      .fn()
      .mockImplementation(async () =>
        jwksResponse([signingJwk], "public, max-age=3600"),
      );
    const getKey = createVercelJwks(JWKS_URL, { fetchFn, now: () => now });
    const token = await sign();

    await verifyVercelOidcToken(token, {
      integrationId: INTEGRATION_ID,
      getKey,
    });
    now += 3_599_000;
    await verifyVercelOidcToken(token, {
      integrationId: INTEGRATION_ID,
      getKey,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += 2_000;
    await verifyVercelOidcToken(token, {
      integrationId: INTEGRATION_ID,
      getKey,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refetches on an unknown kid, at most once per cooldown", async () => {
    let now = 1_000_000;
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => jwksResponse([signingJwk]))
      .mockImplementation(async () => jwksResponse([signingJwk, otherJwk]));
    const getKey = createVercelJwks(JWKS_URL, { fetchFn, now: () => now });

    await verifyVercelOidcToken(await sign(), {
      integrationId: INTEGRATION_ID,
      getKey,
    });
    const rotated = await sign({ kid: "k2", key: other.privateKey });

    // Inside the cooldown the unknown kid is rejected without a refetch.
    now += 10_000;
    await expectInvalid(rotated, getKey);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += 30_000;
    await expect(
      verifyVercelOidcToken(rotated, { integrationId: INTEGRATION_ID, getKey }),
    ).resolves.toMatchObject({ resource: "res_1" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps using cached keys for up to 24h when a refresh fails", async () => {
    let now = 1_000_000;
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => jwksResponse([signingJwk]))
      .mockImplementation(async () => new Response("down", { status: 503 }));
    const getKey = createVercelJwks(JWKS_URL, { fetchFn, now: () => now });
    const token = await sign();

    await verifyVercelOidcToken(token, {
      integrationId: INTEGRATION_ID,
      getKey,
    });
    now += 2 * 60 * 60 * 1000;
    await expect(
      verifyVercelOidcToken(token, { integrationId: INTEGRATION_ID, getKey }),
    ).resolves.toMatchObject({ resource: "res_1" });
    expect(error).toHaveBeenCalledWith(
      "Vercel Marketplace JWKS refresh failed, using cached keys",
      expect.any(Object),
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // The failed refresh is not retried on every request.
    now += 1_000;
    await verifyVercelOidcToken(token, {
      integrationId: INTEGRATION_ID,
      getKey,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    now += 23 * 60 * 60 * 1000;
    await expect(
      verifyVercelOidcToken(token, { integrationId: INTEGRATION_ID, getKey }),
    ).rejects.toBeInstanceOf(VercelJwksUnavailableError);
    error.mockRestore();
  });

  it("reports the JWKS unavailable when the first fetch fails", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const getKey = createVercelJwks(JWKS_URL, {
      fetchFn: vi.fn().mockRejectedValue(new Error("network")),
    });
    await expect(
      verifyVercelOidcToken(await sign(), {
        integrationId: INTEGRATION_ID,
        getKey,
      }),
    ).rejects.toBeInstanceOf(VercelJwksUnavailableError);
    error.mockRestore();
  });
});
