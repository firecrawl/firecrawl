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
function app(flags: { unblockedDomains?: string[] } = {}) {
  const app = express();
  app.use(express.json());
  app.all(
    "/exchange/publisher/bounties",
    (req, _res, next) => {
      Object.assign(req, {
        auth: { team_id: "publisher" },
        acuc: {
          org_id: "organization",
          flags,
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
  blocked.mockImplementation(
    (url: string, flags: { unblockedDomains?: string[] } = {}) =>
      !flags.unblockedDomains?.includes("blocked.example") &&
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
  it("rejects blocked domains on updates", async () => {
    const result = await request(app())
      .put("/exchange/publisher/bounties")
      .send({ description: "Use blocked.example profiles" });
    expect(result.status).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
  });
  it("does not apply scrape exemptions to bounty publication", async () => {
    const flags = { unblockedDomains: ["blocked.example"] };
    expect(blocked("https://blocked.example/", flags)).toBe(false);
    blocked.mockClear();
    const result = await request(app(flags))
      .post("/exchange/publisher/bounties")
      .send({ title: "blocked.example profiles" });
    expect(result.status).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(
      "https://blocked.example/",
      {},
      expect.any(Object),
    );
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
