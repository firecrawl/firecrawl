vi.mock("../config", () => ({
  config: { EXCHANGE_INTERNAL_SECRET: "internal-secret" },
}));

import { createHmac } from "node:crypto";
import { config } from "../config";
import {
  MAX_FEEDBACK_TOKEN_LENGTH,
  issueFeedbackToken,
  verifyFeedbackToken,
} from "./alexandria-feedback-token";

const teamId = "01933161-0000-7000-8000-000000000001";
const now = 1_800_000_000_000;
const claims = {
  requestId: "req-1",
  teamId,
  provider: "fred",
  capability: "series/observations",
};

afterEach(() => {
  config.EXCHANGE_INTERNAL_SECRET = "internal-secret";
});

it("round-trips the call it names for the issuing team", () => {
  const token = issueFeedbackToken(claims, now)!;
  expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  expect(token.length).toBeLessThan(200);
  expect(verifyFeedbackToken(token, teamId, now + 1000)).toEqual({
    requestId: "req-1",
    provider: "fred",
    capability: "series/observations",
    issuedAt: now / 1000,
  });
});

it("issues no token that feedback would refuse as too long", () => {
  const long = {
    ...claims,
    provider: "é".repeat(200),
    capability: "能".repeat(200),
  };
  expect(issueFeedbackToken(long, now)).toBeUndefined();
  expect(issueFeedbackToken(claims, now)!.length).toBeLessThanOrEqual(
    MAX_FEEDBACK_TOKEN_LENGTH,
  );
});

it("rejects the token for any other team", () => {
  const token = issueFeedbackToken(claims, now)!;
  expect(
    verifyFeedbackToken(token, "01933161-0000-7000-8000-000000000002", now),
  ).toBeNull();
});

it("expires after 24 hours and refuses tokens from the future", () => {
  const token = issueFeedbackToken(claims, now)!;
  expect(
    verifyFeedbackToken(token, teamId, now + 24 * 3600_000),
  ).not.toBeNull();
  expect(
    verifyFeedbackToken(token, teamId, now + 24 * 3600_000 + 1000),
  ).toBeNull();
  expect(verifyFeedbackToken(token, teamId, now - 120_000)).toBeNull();
});

it("rejects a changed payload, a changed signature and malformed tokens", () => {
  const token = issueFeedbackToken(claims, now)!;
  const [version, payload, signature] = token.split(".");
  const other = Buffer.from(
    JSON.stringify(["req-1", "sec", "series/observations", now / 1000]),
  ).toString("base64url");
  const flipped = Buffer.from(signature, "base64url");
  flipped[0] ^= 1;
  for (const bad of [
    `${version}.${other}.${signature}`,
    `${version}.${payload}.${flipped.toString("base64url")}`,
    `v2.${payload}.${signature}`,
    `${token}.extra`,
    "v1..",
    "",
  ])
    expect(verifyFeedbackToken(bad, teamId, now)).toBeNull();
});

it("rejects a validly signed payload of the wrong shape", () => {
  const key = createHmac("sha256", "internal-secret")
    .update("alexandria-feedback-token:v1")
    .digest();
  const payload = Buffer.from(
    JSON.stringify(["req-1", "fred", 1, now / 1000]),
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`v1.${payload}.${teamId}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  expect(
    verifyFeedbackToken(`v1.${payload}.${signature}`, teamId, now),
  ).toBeNull();
});

it("neither issues nor verifies without a signing key", () => {
  const token = issueFeedbackToken(claims, now)!;
  config.EXCHANGE_INTERNAL_SECRET = undefined as never;
  expect(issueFeedbackToken(claims, now)).toBeUndefined();
  expect(verifyFeedbackToken(token, teamId, now)).toBeNull();
});

it("changes every token when the key rotates", () => {
  const token = issueFeedbackToken(claims, now)!;
  config.EXCHANGE_INTERNAL_SECRET = "rotated";
  expect(verifyFeedbackToken(token, teamId, now)).toBeNull();
});
