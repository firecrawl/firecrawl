import { generateObject, LoadAPIKeyError } from "ai";
import { chunkByChars, checkForPromptInjection } from "./promptInjectionGuard";
import { CostTracking } from "../../../lib/cost-tracking";
import { PromptInjectionDetectedError } from "../error";

vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: vi.fn(),
}));
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn().mockReturnValue({ modelId: "gpt-4o-mini" }),
}));

describe("chunkByChars", () => {
  it("returns the whole text as a single chunk if within the limit", () => {
    expect(chunkByChars("hello world", 1000)).toEqual(["hello world"]);
  });

  it("returns an empty array for empty text", () => {
    expect(chunkByChars("", 10)).toEqual([]);
  });

  it("covers the entire input across chunks with no gaps or overlaps", () => {
    const text = "abcdefghij".repeat(1000);

    const chunks = chunkByChars(text, 37);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps every chunk within the char limit", () => {
    const text = "x".repeat(10000);

    const chunks = chunkByChars(text, 300);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
  });

  it("stays fast on pathological low-entropy input", () => {
    const huge = "A".repeat(10_000_000);

    const start = Date.now();
    chunkByChars(huge, 100000);
    const durationMs = Date.now() - start;

    expect(durationMs).toBeLessThan(1000);
  });

  it("keeps a marker straddling a chunk boundary intact in at least one chunk", () => {
    const maxCharsPerChunk = 100;
    const overlap = 20;
    const marker = "INJECT-THIS-PHRASE";
    // Placed to straddle the boundary between the first and second chunk.
    const text = "x".repeat(maxCharsPerChunk - 5) + marker + "y".repeat(500);

    const chunks = chunkByChars(text, maxCharsPerChunk, overlap);

    expect(chunks.some(c => c.includes(marker))).toBe(true);
  });

  it("still respects the char limit per chunk when overlapping", () => {
    const text = "x".repeat(10000);

    const chunks = chunkByChars(text, 300, 50);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
    expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length);
  });
});

describe("checkForPromptInjection", () => {
  const noopLogger = {
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
  } as any;

  const verdict = (isInjection: boolean) => ({
    object: { isInjection, reason: "test" },
    usage: { inputTokens: 100, outputTokens: 10 },
  });

  // Three chunks at the guard's 32k chunk size with 2k overlap.
  const threeChunkMarkdown = "x".repeat(80_000);

  const run = (costTracking: CostTracking, markdown = threeChunkMarkdown) =>
    checkForPromptInjection({
      markdown,
      logger: noopLogger,
      costTracking,
      metadata: { teamId: "test-team" },
      zeroDataRetention: false,
    });

  const guardVerdicts = (costTracking: CostTracking) =>
    costTracking.calls
      .filter(call => call.metadata.method === "checkForPromptInjection")
      .map(call => call.metadata.verdict);

  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("resolves true and records a clean verdict per chunk when every chunk scans", async () => {
    vi.mocked(generateObject).mockResolvedValue(verdict(false) as any);
    const costTracking = new CostTracking();

    await expect(run(costTracking)).resolves.toBe(true);
    expect(guardVerdicts(costTracking)).toEqual(["clean", "clean", "clean"]);
  });

  it("fails open and resolves false when one chunk's classifier call errors", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(verdict(false) as any)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(verdict(false) as any);
    const costTracking = new CostTracking();

    await expect(run(costTracking)).resolves.toBe(false);
    expect(guardVerdicts(costTracking).sort()).toEqual([
      "clean",
      "clean",
      "none",
    ]);
  });

  it("records a no-verdict call when the request was never dispatched", async () => {
    vi.mocked(generateObject).mockRejectedValue(
      new LoadAPIKeyError({ message: "missing key" }),
    );
    const costTracking = new CostTracking();

    await expect(run(costTracking, "short page")).resolves.toBe(false);
    expect(guardVerdicts(costTracking)).toEqual(["none"]);
    expect(costTracking.toJSON().totalCost).toBe(0);
  });

  it("throws and records an injection verdict on a detection", async () => {
    vi.mocked(generateObject).mockResolvedValue(verdict(true) as any);
    const costTracking = new CostTracking();

    await expect(run(costTracking, "short page")).rejects.toBeInstanceOf(
      PromptInjectionDetectedError,
    );
    expect(guardVerdicts(costTracking)).toEqual(["injection"]);
  });

  it("resolves true without calling the classifier for empty content", async () => {
    const costTracking = new CostTracking();

    await expect(run(costTracking, "   ")).resolves.toBe(true);
    expect(generateObject).not.toHaveBeenCalled();
  });
});
