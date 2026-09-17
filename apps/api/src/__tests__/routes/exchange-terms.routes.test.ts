import express from "express";
import request from "supertest";
import { fetch } from "undici";
import { acceptProviderTerms } from "../../services/alexandria/terms";

vi.mock("../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.test" },
}));
vi.mock("../../lib/logger", () => {
  const logger = { child: () => logger, error: vi.fn() };
  return { logger };
});
vi.mock("undici", () => ({ Agent: class {}, fetch: vi.fn() }));
vi.mock("../../routes/exchange-blocklist", () => ({
  bountyBlocklistMiddleware: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../controllers/v2/scrape-alexandria", () => ({
  providerScrapeController: vi.fn(),
}));
vi.mock("../../lib/team-org", () => ({
  orgIdFromAcuc: (acuc: any) => acuc?.org_id ?? null,
}));
vi.mock("../../services/alexandria/terms", async importOriginal => ({
  ...(await importOriginal<typeof import("../../services/alexandria/terms")>()),
  acceptProviderTerms: vi.fn(),
}));
vi.mock("../../routes/shared", () => ({
  authMiddleware: () => (req: any, res: any, next: any) => {
    if (!req.headers.authorization) return res.sendStatus(401);
    req.auth = { team_id: "team-without-retrieve" };
    req.acuc = {
      flags: { exchangeRetrieve: false },
      org_id: req.headers["x-test-org"] ?? null,
    };
    next();
  },
  wrap: (fn: any) => fn,
}));
import { exchangeRouter } from "../../routes/exchange";
const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);
beforeEach(() => {
  vi.mocked(fetch).mockReset();
  vi.mocked(acceptProviderTerms).mockReset();
  vi.mocked(fetch).mockResolvedValue({
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ providers: [{ provider: "particle" }] }),
  } as any);
});
describe("provider terms review routes", () => {
  it.each([
    "/provider-terms?providers=particle&surface=cli",
    "/provider-terms/particle",
  ])(
    "allows authenticated review of %s before retrieval is enabled",
    async path => {
      const response = await request(app)
        .get(`/exchange${path}`)
        .set("Authorization", "Bearer test");
      expect(response.status).toBe(200);
      expect(response.body.providers).toEqual([{ provider: "particle" }]);
      expect(fetch).toHaveBeenCalledWith(
        `https://exchange.test/v1${path}`,
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "x-exchange-team-id": "team-without-retrieve",
          }),
        }),
      );
      expect(acceptProviderTerms).not.toHaveBeenCalled();
    },
  );
  it("still requires authentication", async () => {
    expect((await request(app).get("/exchange/provider-terms")).status).toBe(
      401,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not ungate ledger writes", async () => {
    const response = await request(app)
      .post("/exchange/provider-terms/events")
      .set("Authorization", "Bearer test")
      .send({ type: "accepted" });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("still requires an organization for acceptance", async () => {
    const response = await request(app)
      .post("/exchange/provider-terms/accept")
      .set("Authorization", "Bearer test")
      .send({ provider: "particle", confirmed: true });
    expect(response.status).toBe(403);
    expect(acceptProviderTerms).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves the acceptance service's authority refusal", async () => {
    vi.mocked(acceptProviderTerms).mockResolvedValue({
      status: 403,
      body: {
        success: false,
        code: "AUTHORITY_REQUIRED",
        error: "Admin authority required",
      },
    });
    const response = await request(app)
      .post("/exchange/provider-terms/accept")
      .set("Authorization", "Bearer test")
      .set("x-test-org", "org-1")
      .send({
        provider: "particle",
        version: "v1",
        digest: "a".repeat(64),
        confirmed: true,
      });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("AUTHORITY_REQUIRED");
    expect(acceptProviderTerms).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
