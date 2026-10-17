/**
 * Engpicker runs every engine for every sampled URL inside a single
 * Promise.all. A throw from one evaluation therefore aborts the whole job
 * before the verdict insert and the `done: true` update, leaving the queue row
 * permanently picked up. These tests pin the failure-isolation behaviour and
 * the meaning of the `evaluated` flag.
 */

const scrapeURL = vi.fn();
const generateObject = vi.fn();
const computeEngpickerVerdict = vi.fn();

vi.mock("../../scraper/scrapeURL", () => ({
  scrapeURL: (...args: unknown[]) => scrapeURL(...args),
}));
vi.mock("../../scraper/scrapeURL/engines", () => ({}));
vi.mock("../../db/connection", () => ({ dbIndex: {} }));
vi.mock("../../db/schema", () => ({}));
vi.mock("../../db/rpc", () => ({ queryIndexAtDomainSplitLevelOmce: vi.fn() }));
vi.mock("./cost-tracking", () => ({ CostTracking: class {} }));
vi.mock("../../controllers/v2/types", () => ({
  scrapeOptions: { parse: (v: unknown) => v },
}));
vi.mock("./generic-ai", () => ({ getModel: () => "test-model" }));
vi.mock("@mendable/firecrawl-rs", () => ({
  computeEngpickerVerdict: (...args: unknown[]) =>
    computeEngpickerVerdict(...args),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as any;

function okScrape() {
  return {
    success: true,
    document: { markdown: "# Real page content" },
  };
}

async function loadEngpicker() {
  vi.resetModules();
  const { generateObject: realGenerateObject } = await import("ai");
  vi.doMock("ai", async () => {
    const actual = await vi.importActual<typeof import("ai")>("ai");
    return { ...actual, generateObject };
  });
  void realGenerateObject;
  return import("../../lib/engpicker.js");
}

describe("engpicker evaluateURL failure isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scrapeURL.mockResolvedValue(okScrape());
  });

  it("reports a successful evaluation with evaluated: true", async () => {
    generateObject.mockResolvedValue({ object: { is_successful: true } });
    const { evaluateURL } = await loadEngpicker();

    const result = await evaluateURL(
      "job-1",
      "https://example.com",
      "fire-engine;chrome-cdp",
      false,
      mockLogger,
    );

    expect(result).toMatchObject({
      result: true,
      evaluated: true,
      markdown: "# Real page content",
    });
  });

  it("distinguishes a negative verdict from an evaluation failure", async () => {
    generateObject.mockResolvedValue({ object: { is_successful: false } });
    const { evaluateURL } = await loadEngpicker();

    const result = await evaluateURL(
      "job-2",
      "https://example.com",
      "fire-engine;chrome-cdp",
      false,
      mockLogger,
    );

    // The model ran and judged the scrape unsuccessful.
    expect(result).toMatchObject({ result: false, evaluated: true });
  });

  it("does not throw when the provider call fails", async () => {
    generateObject.mockRejectedValue(new Error("400 json_schema unsupported"));
    const { evaluateURL } = await loadEngpicker();

    // Resolving (not rejecting) is what keeps the job alive.
    const result = await evaluateURL(
      "job-3",
      "https://example.com",
      "fire-engine;chrome-cdp",
      false,
      mockLogger,
    );

    // On a thrown failure the markdown is not carried into the unavailable
    // observation, so nothing downstream can mistake it for evidence.
    expect(result).toMatchObject({
      result: false,
      evaluated: false,
      markdown: null,
    });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("survives every failure mode the provider can throw", async () => {
    const { evaluateURL } = await loadEngpicker();
    for (const error of [
      new Error("connect ECONNREFUSED"),
      Object.assign(new Error("timed out"), { name: "AbortError" }),
      new Error("500 internal error"),
      new Error("rate limit exceeded"),
      new Error("invalid api key"),
    ]) {
      generateObject.mockRejectedValue(error);
      await expect(
        evaluateURL(
          "job-4",
          "https://example.com",
          "fire-engine;chrome-cdp",
          false,
          mockLogger,
        ),
      ).resolves.toMatchObject({ evaluated: false });
    }
  });

  it("a failed evaluation never becomes a confident success", async () => {
    generateObject.mockRejectedValue(new Error("boom"));
    const { evaluateURL } = await loadEngpicker();
    const result = await evaluateURL(
      "job-5",
      "https://example.com",
      "fire-engine;chrome-cdp",
      false,
      mockLogger,
    );
    expect(result.result).toBe(false);
    expect(result.evaluated).toBe(false);
  });

  it("K: resolves evaluated:false when scrapeURL throws", async () => {
    // The isolation boundary must cover the scrape, not just the evaluation:
    // a rejection here would abort the enclosing Promise.all and strand the job.
    for (const error of [
      new Error("scrape timeout"),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      new Error("ECONNREFUSED"),
      new Error("internal engine failure"),
    ]) {
      scrapeURL.mockRejectedValue(error);
      const { evaluateURL } = await loadEngpicker();
      await expect(
        evaluateURL(
          "job-k",
          "https://example.com",
          "fire-engine;chrome-cdp",
          false,
          mockLogger,
        ),
      ).resolves.toMatchObject({ evaluated: false, result: false });
    }
  });

  it("marks a failed scrape as evaluated, since that is a real verdict", async () => {
    scrapeURL.mockResolvedValue({ success: false, error: "blocked" });
    const { evaluateURL } = await loadEngpicker();

    const result = await evaluateURL(
      "job-6",
      "https://example.com",
      "fire-engine;chrome-cdp",
      false,
      mockLogger,
    );

    expect(result).toMatchObject({
      result: false,
      evaluated: true,
      markdown: null,
    });
    // The evaluator must not be consulted when the scrape itself failed.
    expect(generateObject).not.toHaveBeenCalled();
  });
});

describe("engpicker native-input evidence filtering", () => {
  const E = (
    engine: import("../../lib/engpicker.js").EngpickerEvaluation["engine"],
    evaluated: boolean,
    result = true,
  ) => ({
    engine,
    stealth: engine.includes("stealth"),
    markdown: evaluated ? "content" : null,
    result: evaluated ? result : false,
    evaluated,
  });

  const ALL_FOUR: import("../../lib/engpicker.js").EngpickerEvaluation["engine"][] =
    [
      "fire-engine;chrome-cdp",
      "fire-engine;chrome-cdp;stealth",
      "fire-engine;tlsclient",
      "fire-engine;tlsclient;stealth",
    ];

  async function load() {
    vi.resetModules();
    return import("../../lib/engpicker.js");
  }

  it("M: includes a fully evaluated sample", async () => {
    const { buildEngpickerNativeInput } = await load();
    const input = buildEngpickerNativeInput([
      { url: "https://a.com", results: ALL_FOUR.map(e => E(e, true, true)) },
    ]);
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      url: "https://a.com",
      cdpBasicSuccess: true,
      tlsStealthSuccess: true,
    });
  });

  it("M: excludes a URL whose TLS evaluations are unavailable", async () => {
    const { buildEngpickerNativeInput } = await load();
    const input = buildEngpickerNativeInput([
      {
        url: "https://a.com",
        results: [
          E("fire-engine;chrome-cdp", true, true),
          E("fire-engine;chrome-cdp;stealth", true, true),
          E("fire-engine;tlsclient", false),
          E("fire-engine;tlsclient;stealth", false),
        ],
      },
    ]);
    // The key regression: this must not become tlsSuccess:false, which the
    // native scorer would read as evidence and could conclude ChromeCdpRequired.
    expect(input).toEqual([]);
  });

  it("M: excludes a URL when one CDP evaluation is unavailable", async () => {
    const { buildEngpickerNativeInput } = await load();
    const input = buildEngpickerNativeInput([
      {
        url: "https://a.com",
        results: [
          E("fire-engine;chrome-cdp", false),
          E("fire-engine;chrome-cdp;stealth", true, true),
          E("fire-engine;tlsclient", true, true),
          E("fire-engine;tlsclient;stealth", true, true),
        ],
      },
    ]);
    expect(input).toEqual([]);
  });

  it("N: keeps a genuine negative TLS evaluation as real evidence", async () => {
    const { buildEngpickerNativeInput } = await load();
    const input = buildEngpickerNativeInput([
      {
        url: "https://a.com",
        results: [
          E("fire-engine;chrome-cdp", true, true),
          E("fire-engine;chrome-cdp;stealth", true, true),
          E("fire-engine;tlsclient", true, false),
          E("fire-engine;tlsclient;stealth", true, false),
        ],
      },
    ]);
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      tlsBasicSuccess: false,
      tlsStealthSuccess: false,
      cdpBasicSuccess: true,
    });
  });

  it("scores only the fully evaluated subset", async () => {
    const { buildEngpickerNativeInput } = await load();
    const input = buildEngpickerNativeInput([
      { url: "https://good.com", results: ALL_FOUR.map(e => E(e, true, true)) },
      {
        url: "https://outage.com",
        results: [
          E("fire-engine;chrome-cdp", true, true),
          E("fire-engine;chrome-cdp;stealth", true, true),
          E("fire-engine;tlsclient", false),
          E("fire-engine;tlsclient;stealth", false),
        ],
      },
    ]);
    expect(input.map(i => i.url)).toEqual(["https://good.com"]);
  });

  it("returns an empty sample when nothing has complete evidence", async () => {
    const { buildEngpickerNativeInput } = await load();
    const input = buildEngpickerNativeInput([
      {
        url: "https://a.com",
        results: ALL_FOUR.map(e => E(e, false)),
      },
    ]);
    expect(input).toEqual([]);
  });
});
