import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import type { config as AppConfig } from "../../config";
import type { TeamFlags } from "../../controllers/v2/types";

type MockAuthRequest = Request & {
  auth?: { team_id: string };
  acuc?: { flags: TeamFlags };
  caller?: {
    teamId: string;
    kind: string;
    auth: { team_id: string };
    acuc?: { flags: TeamFlags };
  };
};

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  auth: { team_id: "team-1" },
  acuc: undefined as { flags: TeamFlags } | undefined,
}));

vi.mock("geoip-country", () => ({ lookup: mocks.lookup }));

vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<{ config: typeof AppConfig }>();
  return {
    ...actual,
    config: {
      ...actual.config,
      RESTRICTED_COUNTRIES: ["XX"],
    },
  };
});

// Real routers and country checks; auth is stubbed and the terminal handler
// ends the chain with a 204, so a 204 means the request got past the country check.
vi.mock("../../routes/shared", async importOriginal => {
  const actual = await importOriginal<{ countryCheck: typeof countryCheck }>();
  return {
    ...actual,
    authMiddleware:
      () => (req: MockAuthRequest, _res: Response, next: NextFunction) => {
        req.auth = mocks.auth;
        req.acuc = mocks.acuc;
        req.caller = {
          teamId: mocks.auth.team_id,
          kind: "api-key",
          auth: mocks.auth,
          acuc: mocks.acuc,
        };
        next();
      },
    checkCreditsMiddleware: () => (_req: Request, res: Response) => {
      res.status(204).end();
    },
  };
});

vi.mock("../../controllers/v2/scrape", () => ({
  scrapeController: (_req: Request, res: Response) => {
    res.status(204).end();
  },
}));

vi.mock("../../controllers/v2/crawl", () => ({
  crawlController: (_req: Request, res: Response) => {
    res.status(204).end();
  },
}));

import {
  authMiddleware,
  checkCreditsMiddleware,
  countryCheck,
} from "../../routes/shared";
import { v2Router } from "../../routes/v2";
import { coreParts, createService, logsMessages } from "../../service";
import { replaceService } from "../../service/service";
import { testService, withService } from "../../service/testing";
import { RateLimiterMode } from "../../types";

const app = express();
app.use(express.json());
app.use("/v2", v2Router);
app.post(
  "/country-checked",
  authMiddleware(RateLimiterMode.Scrape),
  countryCheck,
  checkCreditsMiddleware(),
);

function fromCountry(country: string) {
  mocks.lookup.mockReturnValue({ country });
}

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.auth = { team_id: "team-1" };
  mocks.acuc = { flags: {} };
  replaceService(createService({}, coreParts()));
});

afterEach(() => {
  replaceService(undefined);
});

describe("countryCheck middleware", () => {
  it("rejects requests from a restricted country", async () => {
    fromCountry("XX");

    const res = await request(app).post("/country-checked").send({});

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain(
      "the agent, and browser/interact sessions is not allowed by default in your country",
    );
    expect(mocks.lookup).toHaveBeenCalled();
  });

  it("lets requests from other countries through", async () => {
    fromCountry("YY");

    const res = await request(app).post("/country-checked").send({});

    expect(res.status).toBe(204);
  });

  it("rejects restricted scrape options without a team ACUC from a restricted country", async () => {
    fromCountry("XX");
    mocks.auth = { team_id: "preview_keyless_127.0.0.1" };
    mocks.acuc = undefined;

    const res = await request(app)
      .post("/v2/scrape")
      .send({ url: "https://example.com", headers: { "x-test": "1" } });

    expect(res.status).toBe(403);
  });

  it("honors the team's skipCountryCheck flag", async () => {
    fromCountry("XX");
    mocks.acuc = { flags: { skipCountryCheck: true } };

    const res = await request(app).post("/country-checked").send({});

    expect(res.status).toBe(204);
  });

  it("uses the default messages module copy", async () => {
    fromCountry("XX");

    const res = await request(app).post("/country-checked").send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("check your server configuration");
  });

  it("uses a custom messages module when configured on the service", async () => {
    fromCountry("XX");
    const customService = testService({}, coreParts(), {
      messages: {
        ...logsMessages(),
        restrictedCountryContact: () => "Please contact support.",
      },
    });

    await withService(customService, async () => {
      const res = await request(app).post("/country-checked").send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe(
        "Use of headers, actions, the agent, and browser/interact sessions is not allowed by default in your country. Please contact support.",
      );
    });
  });
});

describe("country check on scrape-style routes", () => {
  it("lets a plain scrape from a restricted country through", async () => {
    fromCountry("XX");

    const res = await request(app)
      .post("/v2/scrape")
      .send({ url: "https://example.com" });

    expect(res.status).toBe(204);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects a scrape with headers from a restricted country", async () => {
    fromCountry("XX");

    const res = await request(app)
      .post("/v2/scrape")
      .send({ url: "https://example.com", headers: { "x-test": "1" } });

    expect(res.status).toBe(403);
  });

  it("rejects a crawl with scrape actions from a restricted country", async () => {
    fromCountry("XX");

    const res = await request(app)
      .post("/v2/crawl")
      .send({
        url: "https://example.com",
        scrapeOptions: { actions: [{ type: "wait", milliseconds: 1 }] },
      });

    expect(res.status).toBe(403);
  });
});
