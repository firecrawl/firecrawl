import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  execute: vi.fn(),
  enabled: true,
}));
vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: state.fetch,
}));
vi.mock("../config", () => ({
  config: { FIRE_EXCHANGE_URL: "http://exchange.internal" },
}));
vi.mock("../db/connection", () => ({ db: { execute: state.execute } }));
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}));
vi.mock("./exchange-blocklist", () => ({
  bountyBlocklistMiddleware: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));
vi.mock("./shared", () => ({
  wrap: (handler: unknown) => handler,
  authMiddleware: () => (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== "Bearer test-key")
      return res.sendStatus(401);
    Object.assign(req, {
      auth: { team_id: "trusted-team" },
      acuc: { flags: { exchangeRetrieve: state.enabled } },
    });
    next();
  },
}));
import { exchangeRouter } from "./exchange";
const app = express().use(express.json()).use("/exchange", exchangeRouter);
const terms = { key: "particle", version: "v1", digest: "a".repeat(64) };
const call = {
  provider: "particle",
  capability: "podcasts/search",
  options: {},
};
function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.execute.mockResolvedValue({
    rows: [
      {
        org_id: "org",
        data_source_id: "particle",
        status: "enabled",
        terms_key: "particle",
        terms_version: "v1",
        terms_accepted_at: "2026-09-10",
        settings: { terms_digest: terms.digest },
      },
    ],
  });
  state.fetch.mockImplementation(async (url: string) =>
    url.endsWith("/requirements")
      ? answer({ providers: [{ provider: "particle", required: true, terms }] })
      : answer({ success: true }),
  );
});
it("exposes the terms catalogue without the retrieval flag, using trusted identity", async () => {
  state.enabled = false;
  const res = await request(app)
    .get("/exchange/provider-terms?surface=web")
    .set("authorization", "Bearer test-key")
    .set("x-exchange-team-id", "spoof")
    .set("x-exchange-extended-catalog-access", "true");
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(state.fetch).toHaveBeenCalledWith(
    "http://exchange.internal/v1/provider-terms?surface=web",
    expect.objectContaining({
      headers: expect.objectContaining({
        "x-exchange-team-id": "trusted-team",
        "x-exchange-extended-catalog-access": "false",
      }),
    }),
  );
  expect(state.execute).not.toHaveBeenCalled();
});
it("requires authentication for terms", async () => {
  expect((await request(app).get("/exchange/provider-terms")).status).toBe(401);
  expect(state.fetch).not.toHaveBeenCalled();
});
it("forwards an accepted request only after checking requirements and the database", async () => {
  const res = await request(app)
    .post("/exchange/retrieve")
    .set("authorization", "Bearer test-key")
    .send(call);
  expect(res.status).toBe(200);
  expect(state.fetch.mock.calls.map(([url]) => url)).toEqual([
    "http://exchange.internal/v1/provider-terms/requirements",
    "http://exchange.internal/v1/retrieve",
  ]);
  expect(JSON.parse(state.fetch.mock.calls[1][1].body)).toEqual(call);
  expect(state.execute.mock.invocationCallOrder[0]).toBeLessThan(
    state.fetch.mock.invocationCallOrder[1],
  );
});
it("blocks an unaccepted batch before forwarding any execution", async () => {
  state.execute.mockResolvedValue({
    rows: [
      {
        org_id: "org",
        data_source_id: null,
        status: null,
        terms_key: null,
        terms_version: null,
        terms_accepted_at: null,
        settings: null,
      },
    ],
  });
  const res = await request(app)
    .post("/exchange/retrieve")
    .set("authorization", "Bearer test-key")
    .send({ requests: [call, call] });
  expect(res.status).toBe(403);
  expect(state.fetch).toHaveBeenCalledTimes(1);
});
it("does not check or execute when the preview flag is absent", async () => {
  state.enabled = false;
  expect(
    (
      await request(app)
        .post("/exchange/retrieve")
        .set("authorization", "Bearer test-key")
        .send(call)
    ).status,
  ).toBe(403);
  expect(state.fetch).not.toHaveBeenCalled();
});
it.each(["unavailable", "malformed", "timeout", "database"])(
  "fails closed on %s",
  async failure => {
    if (failure === "unavailable")
      state.fetch.mockResolvedValue(answer({ error: "not deployed" }, 503));
    if (failure === "malformed")
      state.fetch.mockResolvedValue(answer({ providers: [] }));
    if (failure === "timeout")
      state.fetch.mockRejectedValue(
        new DOMException("timeout", "TimeoutError"),
      );
    if (failure === "database")
      state.execute.mockRejectedValue(new Error("unavailable"));
    const res = await request(app)
      .post("/exchange/retrieve")
      .set("authorization", "Bearer test-key")
      .send(call);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  },
);
it("keeps discovery independent of acceptance", async () => {
  expect(
    (
      await request(app)
        .get("/exchange/discover")
        .set("authorization", "Bearer test-key")
    ).status,
  ).toBe(200);
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.fetch.mock.calls[0][0]).toBe(
    "http://exchange.internal/v1/discover",
  );
});
