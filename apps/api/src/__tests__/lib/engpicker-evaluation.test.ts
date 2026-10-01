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

    expect(result).toMatchObject({
      result: false,
      evaluated: false,
      markdown: "# Real page content",
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

describe("engpicker verdict folding for unevaluated engines", () => {
  // Architectural note: `EngpickerUrlResult` (Rust, fixed-shape booleans)
  // cannot represent "no verdict". An unevaluated engine is therefore sent as
  // success: false, which computeEngpickerVerdict counts as a CDP failure.
  // This test pins that consequence so a future change to the fold is visible.
  it("folds evaluated:false into the existing uncertain semantics", async () => {
    computeEngpickerVerdict.mockResolvedValue({ verdict: "Uncertain" });
    const verdict = await computeEngpickerVerdict(
      [
        {
          url: "https://example.com",
          cdpBasicMarkdown: "content",
          cdpBasicSuccess: false, // evaluated: false folds here
          cdpStealthMarkdown: undefined,
          cdpStealthSuccess: false,
          tlsBasicMarkdown: undefined,
          tlsBasicSuccess: false,
          tlsStealthMarkdown: undefined,
          tlsStealthSuccess: false,
        },
      ],
      0.85,
      0.7,
      0.5,
    );
    expect(verdict.verdict).toBe("Uncertain");
  });
});
