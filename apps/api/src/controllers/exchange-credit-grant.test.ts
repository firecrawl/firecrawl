const { mocks } = vi.hoisted(() => ({
  mocks: {
    refundCredits: vi.fn(),
    getACUCTeam: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
  },
}));
vi.mock("../services/autumn/autumn.service", () => ({
  CREDITS_FEATURE_ID: "CREDITS",
  autumnService: { refundCredits: mocks.refundCredits },
}));
vi.mock("./auth", () => ({ getACUCTeam: mocks.getACUCTeam }));
vi.mock("../lib/logger", () => {
  const child = { info: mocks.logInfo, warn: mocks.logWarn, error: vi.fn() };
  return { logger: { ...child, child: () => child } };
});

import express from "express";
import request from "supertest";
import { config } from "../config";
import { notFoundHandler } from "../lib/not-found";
import { exchangeCreditGrantController } from "./exchange-credit-grant";

const PATH = "/exchange-internal/credit-grants";
const SECRET = "exchange-internal-secret-0001";
const grant = {
  grantId: "01933161-0000-7000-8000-0000000000aa",
  kind: "earning",
  teamId: "01933161-0000-7000-8000-000000000001",
  credits: 25,
};
const original = {
  enabled: config.EXCHANGE_CREDIT_GRANTS_ENABLED,
  secret: config.EXCHANGE_INTERNAL_SECRET,
  maxCredits: config.EXCHANGE_CREDIT_GRANT_MAX_CREDITS,
  dbAuth: config.USE_DB_AUTHENTICATION,
};

const app = express();
app.use(express.json());
app.post(PATH, (req, res, next) => {
  exchangeCreditGrantController(req, res).catch(next);
});
app.use(notFoundHandler);

const post = (body: unknown = grant, secret: string | null = SECRET) => {
  const call = request(app).post(PATH);
  if (secret !== null) call.set("x-exchange-secret", secret);
  return call.send(body as object);
};
const expectNothingCalled = () => {
  expect(mocks.getACUCTeam).not.toHaveBeenCalled();
  expect(mocks.refundCredits).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  config.EXCHANGE_CREDIT_GRANTS_ENABLED = true;
  config.EXCHANGE_INTERNAL_SECRET = SECRET;
  config.EXCHANGE_CREDIT_GRANT_MAX_CREDITS = 100;
  config.USE_DB_AUTHENTICATION = true;
  mocks.getACUCTeam.mockResolvedValue({ org_id: "org-1" });
  mocks.refundCredits.mockResolvedValue(true);
});
afterAll(() => {
  config.EXCHANGE_CREDIT_GRANTS_ENABLED = original.enabled;
  config.EXCHANGE_INTERNAL_SECRET = original.secret;
  config.EXCHANGE_CREDIT_GRANT_MAX_CREDITS = original.maxCredits;
  config.USE_DB_AUTHENTICATION = original.dbAuth;
});

it.each([
  ["the flag is off", () => (config.EXCHANGE_CREDIT_GRANTS_ENABLED = false)],
  [
    "the secret is unset",
    () => (config.EXCHANGE_INTERNAL_SECRET = undefined as never),
  ],
  [
    "database authentication is off",
    () => (config.USE_DB_AUTHENTICATION = false),
  ],
])("answers like an unknown route when %s", async (_name, turnOff) => {
  turnOff();
  const unknownPath = "/exchange-internal/unknown";
  const unknown = await request(app)
    .post(unknownPath)
    .set("x-exchange-secret", SECRET)
    .send(grant);

  // A wrong secret too: the flag is checked first.
  for (const secret of [SECRET, "wrong", null]) {
    const res = await post(grant, secret);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      ...unknown.body,
      error: unknown.body.error.replace(unknownPath, PATH),
    });
  }
  expect(unknown.status).toBe(404);
  expectNothingCalled();
});

it.each([
  ["missing", null],
  ["wrong", "exchange-internal-secret-0002"],
  ["wrong and shorter", "wrong"],
])("rejects a %s secret with 401", async (_name, secret) => {
  const res = await post(grant, secret);

  expect(res.status).toBe(401);
  expect(res.body).toEqual({ success: false, error: "Unauthorized" });
  expectNothingCalled();
});

it.each([
  ["no grantId", { ...grant, grantId: undefined }],
  ["a grantId that is not a uuid", { ...grant, grantId: "grant-1" }],
  ["an unknown kind", { ...grant, kind: "bonus" }],
  ["no teamId", { ...grant, teamId: undefined }],
  ["a teamId that is not a uuid", { ...grant, teamId: "preview_team" }],
  ["zero credits", { ...grant, credits: 0 }],
  ["negative credits", { ...grant, credits: -5 }],
  ["fractional credits", { ...grant, credits: 1.5 }],
  ["credits as a string", { ...grant, credits: "25" }],
  ["a body that is not an object", [grant]],
])("rejects %s with 400", async (_name, body) => {
  const res = await post(body);

  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ success: false, code: "invalid_body" });
  expectNothingCalled();
});

it("rejects a grant over the cap with 400 grant_too_large", async () => {
  const atCap = await post({ ...grant, credits: 100 });
  expect(atCap.status).toBe(200);
  vi.clearAllMocks();

  const res = await post({ ...grant, credits: 101 });

  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ success: false, code: "grant_too_large" });
  expectNothingCalled();
});

it.each([
  ["an unknown team", null],
  ["a team with no organization", { org_id: null }],
])("answers 422 unknown_team for %s", async (_name, acuc) => {
  mocks.getACUCTeam.mockResolvedValue(acuc);

  const res = await post();

  expect(res.status).toBe(422);
  expect(res.body).toMatchObject({ success: false, code: "unknown_team" });
  expect(mocks.refundCredits).not.toHaveBeenCalled();
});

it("answers 503 when the org lookup fails", async () => {
  mocks.getACUCTeam.mockRejectedValue(new Error("database unavailable"));

  const res = await post();

  expect(res.status).toBe(503);
  expect(res.body).toMatchObject({ success: false, retryable: true });
  expect(mocks.refundCredits).not.toHaveBeenCalled();
});

it("grants once against the team's own org and answers 200", async () => {
  // An org in the body is ignored: it is not part of the contract.
  const res = await post({
    ...grant,
    kind: "reward_refund",
    orgId: "org-from-caller",
  });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true });
  expect(mocks.getACUCTeam).toHaveBeenCalledExactlyOnceWith(grant.teamId);
  expect(mocks.refundCredits).toHaveBeenCalledExactlyOnceWith({
    teamId: grant.teamId,
    orgId: "org-1",
    value: 25,
    featureId: "CREDITS",
    idempotencyKey: `fc:grant:exchange:${grant.grantId}`,
    properties: {
      grantSource: "exchange",
      kind: "reward_refund",
      grantId: grant.grantId,
    },
  });
  expect(mocks.logInfo).toHaveBeenCalledExactlyOnceWith(
    "Exchange credit grant processed",
    {
      grantId: grant.grantId,
      kind: "reward_refund",
      teamId: grant.teamId,
      credits: 25,
      outcome: "granted",
    },
  );
});

it("answers a retryable 503 when billing does not confirm", async () => {
  mocks.refundCredits.mockResolvedValue(false);

  const res = await post();

  expect(res.status).toBe(503);
  expect(res.body).toEqual({
    success: false,
    error: "Billing did not confirm the grant.",
    retryable: true,
  });
  expect(mocks.refundCredits).toHaveBeenCalledTimes(1);
});

it("never logs the secret", async () => {
  mocks.getACUCTeam.mockRejectedValueOnce(new Error("database unavailable"));
  await post();
  await post();
  await post(grant, "wrong");

  const logged = JSON.stringify([
    ...mocks.logInfo.mock.calls,
    ...mocks.logWarn.mock.calls,
  ]);
  expect(logged).toContain(grant.grantId);
  expect(logged).not.toContain(SECRET);
});
