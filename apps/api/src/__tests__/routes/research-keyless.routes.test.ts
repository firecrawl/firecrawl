import express from "express";
import request from "supertest";

const KEYLESS_ENV = {
  KEYLESS_REQUESTS_PER_DAY: "100",
  KEYLESS_CREDITS_PER_DAY: "100",
  USE_DB_AUTHENTICATION: "true",
};

async function loadWithFlag(flag: string | undefined) {
  vi.resetModules();
  for (const [key, value] of Object.entries(KEYLESS_ENV)) {
    process.env[key] = value;
  }
  if (flag === undefined) {
    delete process.env.RESEARCH_KEYLESS_DISABLED;
  } else {
    process.env.RESEARCH_KEYLESS_DISABLED = flag;
  }

  const { config } = await import("../../config.js");
  const { isResearchKeylessDisabled } = await import(
    "../../lib/research-keyless.js"
  );
  return { config, isResearchKeylessDisabled };
}

async function appWithResearchGate(flag: string | undefined) {
  const { isResearchKeylessDisabled } = await loadWithFlag(flag);
  const { authMiddleware } = await import("../../routes/shared.js");
  const { RateLimiterMode } = await import("../../types.js");

  const app = express();
  const router = express.Router();
  const reached = (_req: express.Request, res: express.Response) =>
    res.status(200).json({ reachedController: true });
  router.get("/papers", reached);
  router.get("/papers/:id/similar", reached);
  router.get("/papers/:id", reached);
  router.get("/github", reached);

  app.use(
    "/v2/search/research",
    authMiddleware(RateLimiterMode.Research, {
      allowKeyless: req => !isResearchKeylessDisabled(req),
    }),
    router,
  );
  return app;
}

function fakeRequest(path: string, query: Record<string, unknown> = {}) {
  return { path, query } as unknown as express.Request;
}

describe("RESEARCH_KEYLESS_DISABLED parsing", () => {
  it("covers every paper operation by default when unset", async () => {
    const { config, isResearchKeylessDisabled } = await loadWithFlag(undefined);

    expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([
      "search",
      "inspect",
      "read",
      "similar",
    ]);
    expect(isResearchKeylessDisabled(fakeRequest("/papers/2401.00001"))).toBe(
      true,
    );
    expect(
      isResearchKeylessDisabled(fakeRequest("/papers", { query: "rag" })),
    ).toBe(true);
  });

  it("treats an empty value as unset, so it also gets the default scope", async () => {
    const { config } = await loadWithFlag("");

    expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([
      "search",
      "inspect",
      "read",
      "similar",
    ]);
  });

  it("restores keyless access when explicitly switched off", async () => {
    for (const flag of ["false", "none", "0", "off", "no"]) {
      const { config, isResearchKeylessDisabled } = await loadWithFlag(flag);

      expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([]);
      expect(isResearchKeylessDisabled(fakeRequest("/papers/2401.00001"))).toBe(
        false,
      );
    }
  });

  it("covers every paper operation when switched on explicitly", async () => {
    for (const flag of ["true", "all", "on", "1", "yes"]) {
      const { config } = await loadWithFlag(flag);

      expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([
        "search",
        "inspect",
        "read",
        "similar",
      ]);
    }
  });

  it("accepts an explicit operation list", async () => {
    const { config } = await loadWithFlag("inspect, similar");

    expect(config.RESEARCH_KEYLESS_DISABLED).toEqual(["inspect", "similar"]);
  });

  it("refuses an unknown operation at boot instead of silently ignoring it", async () => {
    await expect(loadWithFlag("inspect,papers")).rejects.toThrow();
  });
});

describe("Research Index paper operation gate", () => {
  it("maps each paper operation to its own flag entry", async () => {
    const { isResearchKeylessDisabled } = await loadWithFlag(
      "inspect,read,similar",
    );

    expect(isResearchKeylessDisabled(fakeRequest("/papers/2401.00001"))).toBe(
      true,
    );
    expect(
      isResearchKeylessDisabled(
        fakeRequest("/papers/2401.00001", { query: "attention" }),
      ),
    ).toBe(true);
    expect(
      isResearchKeylessDisabled(fakeRequest("/papers/2401.00001/similar")),
    ).toBe(true);
    expect(
      isResearchKeylessDisabled(fakeRequest("/papers", { query: "rag" })),
    ).toBe(false);
    expect(
      isResearchKeylessDisabled(fakeRequest("/github", { query: "x" })),
    ).toBe(false);
  });

  it("blocks only the named operation when the scope is narrowed", async () => {
    const { isResearchKeylessDisabled } = await loadWithFlag("inspect");

    expect(isResearchKeylessDisabled(fakeRequest("/papers/2401.00001"))).toBe(
      true,
    );
    expect(
      isResearchKeylessDisabled(
        fakeRequest("/papers/2401.00001", { query: "attention" }),
      ),
    ).toBe(false);
    expect(
      isResearchKeylessDisabled(fakeRequest("/papers/2401.00001/similar")),
    ).toBe(false);
  });

  it("classifies unstripped paths and casing the same way Express routes them", async () => {
    const { isResearchKeylessDisabled } = await loadWithFlag("all");

    expect(
      isResearchKeylessDisabled(
        fakeRequest("/v2/search/research/papers/2401.00001"),
      ),
    ).toBe(true);
    expect(isResearchKeylessDisabled(fakeRequest("/PAPERS/2401.00001"))).toBe(
      true,
    );
    expect(
      isResearchKeylessDisabled(fakeRequest("/papers/2401.00001/SIMILAR")),
    ).toBe(true);
  });
});

describe("keyless Research Index requests through the auth middleware", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await appWithResearchGate(undefined);
  });

  it("refuses a disabled operation with a 401 that asks for an API key", async () => {
    for (const path of [
      "/v2/search/research/papers/2401.00001",
      "/v2/search/research/papers/2401.00001?query=attention",
      "/v2/search/research/papers/2401.00001/similar",
    ]) {
      const response = await request(app).get(path);

      expect(response.statusCode).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain(
        "not supported by the keyless free tier",
      );
      expect(response.body.error).toContain("API key");
      expect(response.body.reachedController).toBeUndefined();
    }
  });

  it("refuses keyless paper search too, now that it is in the default scope", async () => {
    const response = await request(app).get(
      "/v2/search/research/papers?query=transformers",
    );

    expect(response.statusCode).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain(
      "not supported by the keyless free tier",
    );
    expect(response.body.reachedController).toBeUndefined();
  });

  it("leaves the non-paper github operation keyless", async () => {
    const response = await request(app).get("/v2/search/research/github?q=x");

    expect(response.body?.error ?? "").not.toContain(
      "not supported by the keyless free tier",
    );
  });
});
