import express from "express";
import request from "supertest";

// Temporary Research Index keyless mitigation (RESEARCH_KEYLESS_DISABLED).
//
// The end-to-end coverage lives in snips/v2/research.test.ts, which needs a
// running API. These tests own the parts a live server can't vary per-request:
// how the env flag parses, how a request path maps onto a paper operation, and
// that the real auth middleware refuses a keyless call to a disabled operation
// with the "bring an API key" 401 rather than a 500 or a rate-limit error.

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

// Mirrors the Research Index mount in routes/v2.ts, so the gate sees the same
// paths (mount prefix stripped) that production hands it.
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
  it("leaves keyless untouched when unset", async () => {
    const { config, isResearchKeylessDisabled } = await loadWithFlag(undefined);

    expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([]);
    expect(isResearchKeylessDisabled(fakeRequest("/papers/2401.00001"))).toBe(
      false,
    );
  });

  it("treats an empty value as unset, so clearing it is the revert", async () => {
    const { config } = await loadWithFlag("");

    expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([]);
  });

  it("applies the default scope when switched on, keeping paper search keyless", async () => {
    const { config } = await loadWithFlag("true");

    expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([
      "inspect",
      "read",
      "similar",
    ]);
    expect(config.RESEARCH_KEYLESS_DISABLED).not.toContain("search");
  });

  it("covers every paper operation with all", async () => {
    const { config } = await loadWithFlag("all");

    expect(config.RESEARCH_KEYLESS_DISABLED).toEqual([
      "search",
      "inspect",
      "read",
      "similar",
    ]);
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

    // /papers/:id is inspect without a query and read with one.
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
    // Paper search is deliberately outside the default scope.
    expect(
      isResearchKeylessDisabled(fakeRequest("/papers", { query: "rag" })),
    ).toBe(false);
    // GitHub search is not a paper operation.
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
  // routes/shared registers process-wide Prometheus metrics on import, so this
  // file may only build the app once. It uses the default scope.
  let app: express.Express;

  beforeAll(async () => {
    app = await appWithResearchGate("inspect,read,similar");
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

  it("does not refuse keyless paper search under the default scope", async () => {
    const response = await request(app).get(
      "/v2/search/research/papers?query=transformers",
    );

    // Whatever the keyless quota decides, search is never turned away for
    // needing a key.
    expect(response.body?.error ?? "").not.toContain(
      "not supported by the keyless free tier",
    );
  });
});
