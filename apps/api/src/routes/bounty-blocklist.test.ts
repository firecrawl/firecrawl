import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { blocked, forwarded } = vi.hoisted(() => ({
  blocked: vi.fn(),
  forwarded: vi.fn(),
}));
vi.mock("../scraper/WebScraper/utils/blocklist", () => ({
  isUrlBlocked: blocked,
}));
import { bountyBlocklistMiddleware, bountyDomains } from "./bounty-blocklist";
function app() {
  const app = express();
  app.use(express.json());
  app.post(
    "/exchange/publisher/bounties",
    (req, _res, next) => {
      Object.assign(req, {
        auth: { team_id: "publisher" },
        acuc: {
          org_id: "organization",
          flags: { unblockedDomains: ["blocked.example"] },
        },
      });
      next();
    },
    bountyBlocklistMiddleware,
    (_req, res) => {
      forwarded();
      res.json({ published: true });
    },
  );
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(503).json({ error: error.message });
    },
  );
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  blocked.mockImplementation((url: string) =>
    new URL(url).hostname.endsWith("blocked.example"),
  );
});
describe("Bounty domain blocklist", () => {
  it("passes an allowed bounty", async () => {
    const result = await request(app())
      .post("/exchange/publisher/bounties")
      .send({
        title: "Library hours",
        description: "Get branch hours from library.example",
        requirements: ["Return source URLs"],
      });
    expect(result.status).toBe(200);
    expect(forwarded).toHaveBeenCalledOnce();
  });
  it.each([
    { title: "blocked.example profiles" },
    { description: "Use https://Sub.BLOCKED.example/profiles?allowed=true" },
    { requirements: ["Gather from blocked.example."] },
    { description: "Use https://%62locked.example/path" },
  ])("rejects blocked references before publishing %#", async body => {
    const result = await request(app())
      .post("/exchange/publisher/bounties")
      .send(body);
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("bounty_domain_blocked");
    expect(forwarded).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(
      expect.any(String),
      {},
      {
        team_id: "publisher",
        org_id: "organization",
        origin: "exchange-bounty",
      },
    );
    expect(
      blocked.mock.calls.every(([url]) => new URL(url).pathname === "/"),
    ).toBe(true);
  });
  it("does not forward when the blocklist is unavailable", async () => {
    blocked.mockImplementation(() => {
      throw new Error("Blocklist not initialized");
    });
    expect(
      (
        await request(app())
          .post("/exchange/publisher/bounties")
          .send({ title: "library.example" })
      ).status,
    ).toBe(503);
    expect(forwarded).not.toHaveBeenCalled();
  });
  it("deduplicates domains and tolerates malformed fields", () => {
    expect(
      bountyDomains({
        title: "https://library.example/ library.example",
        requirements: [null, {}, "library.example"],
      }),
    ).toEqual(["library.example"]);
    expect(bountyDomains({ title: {}, requirements: "not an array" })).toEqual(
      [],
    );
  });
});
