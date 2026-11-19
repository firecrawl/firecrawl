import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({ getApiKeyTeamFlags: vi.fn() }));

vi.mock("../../controllers/auth", () => ({
  getApiKeyTeamFlags: mocks.getApiKeyTeamFlags,
}));

import {
  deprecationMiddleware,
  hasSunsetExtension,
  sunsetInstant,
} from "../../lib/deprecations";

// An entry whose sunset has passed: Tue, 03 Nov 2026 23:59:59 GMT.
const SUNSET_KEY = "v2_research_github_search";
const BEFORE_SUNSET = new Date("2026-11-01T00:00:00Z");
const AFTER_SUNSET = new Date("2026-11-10T00:00:00Z");

function appFor(
  key: Parameters<typeof deprecationMiddleware>[0],
  acuc?: { flags: unknown },
) {
  const app = express();
  app.get(
    "/probe",
    (req: any, _res, next) => {
      if (acuc) req.acuc = acuc;
      next();
    },
    deprecationMiddleware(key),
    (_req, res) => {
      res.status(200).json({ success: true });
    },
  );
  return app;
}

function extendedUntil(until: string, surface = SUNSET_KEY) {
  return { deprecationExtensions: { [surface]: until } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  mocks.getApiKeyTeamFlags.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sunsetInstant", () => {
  it("reads an exact IMF-fixdate", () => {
    expect(sunsetInstant("k", "Tue, 03 Nov 2026 23:59:59 GMT")).toBe(
      Date.parse("2026-11-03T23:59:59Z"),
    );
  });

  it("is never reached without a sunset", () => {
    expect(sunsetInstant("k", undefined)).toBe(Infinity);
  });

  it.each([
    "Tue, 31 Nov 2026 23:59:59 GMT",
    "Mon, 03 Nov 2026 23:59:59 GMT",
    "3 Nov 2026",
    "2026-11-03",
    "soon",
  ])("refuses %s", sunset => {
    expect(() => sunsetInstant("k", sunset)).toThrow(/unreadable sunset/);
  });
});

describe("hasSunsetExtension", () => {
  const now = Date.parse("2026-12-01T00:00:00Z");

  it("reads the flag under the entry's surface", () => {
    expect(
      hasSunsetExtension(
        "v0_scrape",
        { surface: "v0" },
        extendedUntil("2027-01-31", "v0"),
        now,
      ),
    ).toBe(true);
  });

  it("ignores a flag under the entry key when the entry has a surface", () => {
    expect(
      hasSunsetExtension(
        "v0_scrape",
        { surface: "v0" },
        extendedUntil("2027-01-31", "v0_scrape"),
        now,
      ),
    ).toBe(false);
  });

  it("falls back to the entry key without a surface", () => {
    expect(
      hasSunsetExtension(
        "v1_llmstxt",
        {},
        extendedUntil("2027-01-31", "v1_llmstxt"),
        now,
      ),
    ).toBe(true);
  });

  it("ends at the flag's instant", () => {
    const flags = extendedUntil("2026-12-01T00:00:00Z", "v0");
    expect(
      hasSunsetExtension("v0_scrape", { surface: "v0" }, flags, now - 1),
    ).toBe(true);
    expect(hasSunsetExtension("v0_scrape", { surface: "v0" }, flags, now)).toBe(
      false,
    );
  });

  it("treats a missing or non-string flag as no extension", () => {
    expect(hasSunsetExtension("v0_scrape", { surface: "v0" }, null, now)).toBe(
      false,
    );
    const numeric = { deprecationExtensions: { v0: 20270131 } } as any;
    expect(
      hasSunsetExtension("v0_scrape", { surface: "v0" }, numeric, now),
    ).toBe(false);
  });

  it.each([
    "next spring",
    "2027/01/31",
    "2027-02-30",
    "2027",
    "2027-01-31T12:00:00+02:00",
    "2027-01-31T25:00:00Z",
  ])("treats %s as no extension", until => {
    expect(
      hasSunsetExtension(
        "v0_scrape",
        { surface: "v0" },
        extendedUntil(until, "v0"),
        now,
      ),
    ).toBe(false);
  });
});

describe("deprecationMiddleware sunset gate", () => {
  it("serves the route with a Sunset header before the sunset", async () => {
    vi.setSystemTime(BEFORE_SUNSET);
    const res = await request(appFor(SUNSET_KEY, { flags: null })).get(
      "/probe",
    );

    expect(res.status).toBe(200);
    expect(res.headers["sunset"]).toBe("Tue, 03 Nov 2026 23:59:59 GMT");
    expect(res.body.warnings).toHaveLength(1);
  });

  it("answers 410 after the sunset", async () => {
    vi.setSystemTime(AFTER_SUNSET);
    const res = await request(appFor(SUNSET_KEY, { flags: null })).get(
      "/probe",
    );

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      success: false,
      code: "ENDPOINT_REMOVED",
      replacement: "/v2/search/developer",
    });
    expect(res.headers["sunset"]).toBe("Tue, 03 Nov 2026 23:59:59 GMT");
  });

  it("keeps serving a team whose extension runs later", async () => {
    vi.setSystemTime(AFTER_SUNSET);
    const res = await request(
      appFor(SUNSET_KEY, { flags: extendedUntil("2027-01-31T00:00:00Z") }),
    ).get("/probe");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.warnings).toHaveLength(1);
    expect(mocks.getApiKeyTeamFlags).not.toHaveBeenCalled();
  });

  it("answers 410 once a team's extension has run out", async () => {
    vi.setSystemTime(AFTER_SUNSET);
    const res = await request(
      appFor(SUNSET_KEY, { flags: extendedUntil("2026-11-05T00:00:00Z") }),
    ).get("/probe");

    expect(res.status).toBe(410);
  });

  it("looks the team up by API key on routes that authenticate later", async () => {
    vi.setSystemTime(AFTER_SUNSET);
    mocks.getApiKeyTeamFlags.mockResolvedValueOnce(
      extendedUntil("2027-01-31T00:00:00Z"),
    );
    const extended = await request(appFor(SUNSET_KEY)).get("/probe");

    expect(extended.status).toBe(200);
    expect(mocks.getApiKeyTeamFlags).toHaveBeenCalledTimes(1);

    mocks.getApiKeyTeamFlags.mockResolvedValueOnce(null);
    const unknown = await request(appFor(SUNSET_KEY)).get("/probe");

    expect(unknown.status).toBe(410);
  });

  it("passes a failed lookup on as an error, not a 410", async () => {
    vi.setSystemTime(AFTER_SUNSET);
    mocks.getApiKeyTeamFlags.mockRejectedValueOnce(new Error("lookup down"));
    const res = await request(appFor(SUNSET_KEY)).get("/probe");

    expect(res.status).toBe(500);
  });

  it("never looks anything up for an entry without a sunset", async () => {
    vi.setSystemTime(AFTER_SUNSET);
    const res = await request(appFor("v0_scrape")).get("/probe");

    expect(res.status).toBe(200);
    expect(res.headers["sunset"]).toBeUndefined();
    expect(mocks.getApiKeyTeamFlags).not.toHaveBeenCalled();
  });
});
