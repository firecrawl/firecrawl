import { createHmac } from "node:crypto";
import {
  MCP_DELEGATION,
  TEAM_TOKEN,
  verifySignedCredential,
} from "./signed-credential";

const NOW = 1_800_000_000;
const SECRET = "s".repeat(32);
const TEAM_ID = "3c9a0d5e-7b1f-4a2c-8d6e-9f0a1b2c3d4e";
const GRANT_ID = "5f0c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";

function sign(prefix: string, payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${prefix}${encoded}.${signature}`;
}

const teamToken = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  aud: "firecrawl-core",
  team_id: TEAM_ID,
  api_key_id: 42,
  iat: NOW,
  exp: NOW + 120,
  ...overrides,
});

const verifyTeamToken = (token: string, secret: string | undefined = SECRET) =>
  verifySignedCredential(token, TEAM_TOKEN, secret, NOW);

describe("team token (fct_)", () => {
  it.each([42, null])("accepts a valid token with api_key_id %s", apiKeyId => {
    const payload = teamToken({ api_key_id: apiKeyId });
    expect(verifyTeamToken(sign("fct_", payload))).toEqual(payload);
  });

  it("accepts a token living the full 300 seconds", () => {
    const payload = teamToken({ exp: NOW + 300 });
    expect(verifyTeamToken(sign("fct_", payload))).toEqual(payload);
  });

  it("accepts a full-lifetime token from a clock up to 30 seconds ahead", () => {
    const payload = teamToken({ iat: NOW + 30, exp: NOW + 330 });
    expect(verifyTeamToken(sign("fct_", payload))).toEqual(payload);
  });

  it.each([
    ["expired", { iat: NOW - 120, exp: NOW }],
    ["living longer than 300 seconds", { exp: NOW + 301 }],
    ["issued in the future", { iat: NOW + 31, exp: NOW + 151 }],
    ["expiring before it was issued", { iat: NOW + 10, exp: NOW + 5 }],
    ["carrying a fractional timestamp", { iat: NOW + 0.5 }],
    ["for another audience", { aud: "firecrawl-web" }],
    ["of another version", { v: 2 }],
    ["with a non-uuid team", { team_id: "team-1" }],
    ["with a zero key id", { api_key_id: 0 }],
    ["with a string key id", { api_key_id: "42" }],
    ["with an unsafe key id", { api_key_id: 2 ** 53 }],
    ["with an extra key", { scope: "all" }],
  ])("rejects a token %s", (_label, overrides) => {
    expect(verifyTeamToken(sign("fct_", teamToken(overrides)))).toBeNull();
  });

  it("rejects a token missing a payload key", () => {
    const { api_key_id: _omitted, ...payload } = teamToken();
    expect(verifyTeamToken(sign("fct_", payload))).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = sign("fct_", teamToken(), "o".repeat(32));
    expect(verifyTeamToken(token)).toBeNull();
  });

  it("rejects every token when no secret is configured", () => {
    const token = sign("fct_", teamToken());
    expect(
      verifySignedCredential(token, TEAM_TOKEN, undefined, NOW),
    ).toBeNull();
    expect(verifySignedCredential(token, TEAM_TOKEN, "", NOW)).toBeNull();
  });

  it("rejects a correctly signed but non-canonical payload encoding", () => {
    // This payload's last base64url character carries unused low bits, so
    // flipping one decodes to the same bytes under a different string.
    const [canonical] = sign("fct_", teamToken({ api_key_id: null }))
      .slice(4)
      .split(".");
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const flipped =
      canonical.slice(0, -1) +
      alphabet[alphabet.indexOf(canonical.at(-1)!) ^ 1];
    expect(Buffer.from(flipped, "base64url")).toEqual(
      Buffer.from(canonical, "base64url"),
    );
    const signature = createHmac("sha256", SECRET)
      .update(flipped)
      .digest("base64url");

    expect(verifyTeamToken(`fct_${flipped}.${signature}`)).toBeNull();
  });

  it("rejects an MCP delegation presented as a team token", () => {
    const token = sign("fcmcp_", teamToken());
    expect(verifyTeamToken(token)).toBeNull();
    expect(
      verifySignedCredential(token, MCP_DELEGATION, SECRET, NOW),
    ).toBeNull();
  });
});

describe("MCP delegation (fcmcp_)", () => {
  const v1 = (overrides: Record<string, unknown> = {}) => ({
    v: 1,
    aud: "firecrawl-core",
    purpose: "hosted_mcp_oauth",
    api_key: "fc-11111111111111118111111111111111",
    iat: NOW,
    exp: NOW + 60,
    ...overrides,
  });
  const v2 = (overrides: Record<string, unknown> = {}) => ({
    v: 2,
    aud: "firecrawl-core",
    purpose: "hosted_mcp_oauth",
    api_key_id: 7,
    grant_id: GRANT_ID,
    iat: NOW,
    exp: NOW + 60,
    ...overrides,
  });
  const verify = (payload: unknown) =>
    verifySignedCredential(
      sign("fcmcp_", payload),
      MCP_DELEGATION,
      SECRET,
      NOW,
    );

  it.each([
    ["v1", v1()],
    ["v2", v2()],
  ])("accepts a valid %s payload", (_label, payload) => {
    expect(verify(payload)).toEqual(payload);
  });

  it.each([
    ["v1 living longer than 120 seconds", v1({ exp: NOW + 121 })],
    ["v2 living longer than 120 seconds", v2({ exp: NOW + 121 })],
    ["v1 with a key id", { ...v1(), api_key_id: 7 }],
    ["v2 with a raw key", { ...v2(), api_key: v1().api_key }],
    ["v2 labelled v1", v2({ v: 1 })],
    ["v2 without a grant", v2({ grant_id: null })],
    ["v2 with a non-uuid grant", v2({ grant_id: "grant-1" })],
    ["v2 with a non-positive key id", v2({ api_key_id: -7 })],
    ["v2 for another purpose", v2({ purpose: "general" })],
  ])("rejects %s", (_label, payload) => {
    expect(verify(payload)).toBeNull();
  });
});
