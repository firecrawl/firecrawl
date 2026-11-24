import { generateKeyPairSync } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  INTERNAL_JWT_ENABLED: true,
  INTERNAL_JWT_PUBLIC_KEYS: undefined as string | undefined,
}));
vi.mock("../config", () => ({ config: mockConfig }));
vi.mock("./logger", () => ({ logger: { warn: vi.fn() } }));

import { verifyInternalJwt, internalJwtMiddleware } from "./internal-jwt";
import { redactLogData } from "../services/logging/redact";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }) as string,
    priv: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

async function sign(
  priv: string,
  opts: {
    iss?: string;
    kid?: string;
    ttl?: number;
    iat?: number;
    team?: string;
    aud?: string;
    omit?: "iat" | "exp" | "jti" | "team_id" | "request_id";
    iatValue?: unknown;
  } = {},
) {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    team_id: opts.team ?? "team-1",
    request_id: "req-1",
    jti: "jti-1",
    iat: opts.iatValue ?? iat,
    exp: iat + (opts.ttl ?? 60),
  };
  if (opts.omit) delete claims[opts.omit];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: opts.kid ?? "k1" })
    .setIssuer(opts.iss ?? "firecrawl-web")
    .setAudience(opts.aud ?? "firecrawl-api")
    .sign(await importPKCS8(priv, "EdDSA"));
}

describe("verifyInternalJwt", () => {
  const web = keypair();
  const webNext = keypair();
  const agent = keypair();

  beforeEach(() => {
    mockConfig.INTERNAL_JWT_PUBLIC_KEYS = JSON.stringify({
      "firecrawl-web": { k1: web.pub, k2: webNext.pub },
      "extract-v3": { a1: agent.pub },
    });
  });

  it("accepts either rotation key and each issuer", async () => {
    await expect(
      verifyInternalJwt(await sign(web.priv), "team-1"),
    ).resolves.toEqual({ issuer: "firecrawl-web", requestId: "req-1" });
    await expect(
      verifyInternalJwt(await sign(webNext.priv, { kid: "k2" }), "team-1"),
    ).resolves.toBeTruthy();
    await expect(
      verifyInternalJwt(
        await sign(agent.priv, { iss: "extract-v3", kid: "a1" }),
        "team-1",
      ),
    ).resolves.toBeTruthy();
  });

  it("rejects a key under the wrong issuer or kid", async () => {
    await expect(
      verifyInternalJwt(await sign(agent.priv), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyInternalJwt(await sign(web.priv, { kid: "nope" }), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyInternalJwt(await sign(web.priv, { iss: "other" }), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects expired, over-long and future tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifyInternalJwt(await sign(web.priv, { iat: now - 120 }), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyInternalJwt(await sign(web.priv, { ttl: 3600 }), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyInternalJwt(await sign(web.priv, { iat: now + 600 }), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a wrong audience and a team mismatch", async () => {
    await expect(
      verifyInternalJwt(await sign(web.priv, { aud: "x" }), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyInternalJwt(await sign(web.priv), "team-2"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each([undefined, "", "{}"])(
    "fails closed when keys are %j",
    async keys => {
      mockConfig.INTERNAL_JWT_PUBLIC_KEYS = keys;
      await expect(
        verifyInternalJwt(await sign(web.priv), "team-1"),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it.each(["iat", "exp", "jti", "team_id", "request_id"] as const)(
    "rejects a token missing %s",
    async omit => {
      await expect(
        verifyInternalJwt(await sign(web.priv, { omit }), "team-1"),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it("rejects a non-numeric iat", async () => {
    await expect(
      verifyInternalJwt(await sign(web.priv, { iatValue: "now" }), "team-1"),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("internalJwtMiddleware", () => {
  function run(headers: Record<string, string>, enabled = true) {
    mockConfig.INTERNAL_JWT_ENABLED = enabled;
    const res: any = {
      locals: {},
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    return internalJwtMiddleware()(
      { headers, auth: { team_id: "team-1" } } as any,
      res,
      next,
    ).then(() => ({ res, next }));
  }

  it("ignores the header when the flag is off", async () => {
    const { next, res } = await run(
      { "x-firecrawl-internal-token": "junk" },
      false,
    );
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("stores the caller for a valid token", async () => {
    const { priv, pub } = keypair();
    mockConfig.INTERNAL_JWT_PUBLIC_KEYS = JSON.stringify({
      "firecrawl-web": { k1: pub },
    });
    const { next, res } = await run({
      "x-firecrawl-internal-token": await sign(priv),
    });
    expect(next).toHaveBeenCalled();
    expect(res.locals.internalCaller).toEqual({
      issuer: "firecrawl-web",
      requestId: "req-1",
    });
  });

  it("rejects a bad token when the flag is on", async () => {
    mockConfig.INTERNAL_JWT_PUBLIC_KEYS = undefined;
    const { next, res } = await run({ "x-firecrawl-internal-token": "junk" });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("redactLogData", () => {
  it("redacts compact JWTs inside strings", () => {
    expect(
      redactLogData({
        error: "bad token eyJhbGciOiJFZERTQSJ9.eyJhIjoxfQ.c2ln failed",
      }),
    ).toEqual({ error: "bad token <redacted> failed" });
  });
});
