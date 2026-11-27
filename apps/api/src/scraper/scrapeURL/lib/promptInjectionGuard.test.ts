import { createLogger } from "winston";
import type {
  LoadAPIKeyError as LoadAPIKeyErrorCtor,
  NoObjectGeneratedError as NoObjectGeneratedErrorCtor,
} from "ai";
import { LoadAPIKeyError } from "ai";
import {
  chunkByChars,
  checkForPromptInjection,
  createPromptInjectionGuardLimiter,
} from "./promptInjectionGuard";
import { CostTracking } from "../../../lib/cost-tracking";
import { PromptInjectionDetectedError } from "../error";

type MockGenerateObjectResult = {
  object: { isInjection: boolean; reason: string };
  usage: { inputTokens: number; outputTokens: number };
};

type MockGenerateObjectArgs = {
  telemetry?: {
    isEnabled?: boolean;
    recordInputs?: boolean;
    functionId?: string;
    metadata?: Record<string, string | undefined>;
  };
};

const mocks = vi.hoisted(() => ({
  generateObject:
    vi.fn<
      (args: MockGenerateObjectArgs) => Promise<MockGenerateObjectResult>
    >(),
}));

vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<{
    LoadAPIKeyError: typeof LoadAPIKeyErrorCtor;
    NoObjectGeneratedError: typeof NoObjectGeneratedErrorCtor;
  }>()),
  generateObject: mocks.generateObject,
}));
vi.mock("../../../lib/ai-telemetry", () => ({
  aiTelemetry: (options: unknown) => options,
}));
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn().mockReturnValue({ modelId: "gpt-4o-mini" }),
}));

const noopLogger = createLogger({ silent: true });

const verdict = (isInjection: boolean): MockGenerateObjectResult => ({
  object: { isInjection, reason: "test" },
  usage: { inputTokens: 100, outputTokens: 10 },
});

const guardVerdicts = (costTracking: CostTracking): Array<string> =>
  costTracking.calls
    .filter(call => call.metadata.method === "checkForPromptInjection")
    .map(call =>
      typeof call.metadata.verdict === "string" ? call.metadata.verdict : "",
    );

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
    const text = "x".repeat(10_000);

    const chunks = chunkByChars(text, 300);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
  });

  it("stays fast on pathological low-entropy input", () => {
    const huge = "A".repeat(10_000_000);

    const start = Date.now();
    chunkByChars(huge, 100_000);
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
    const text = "x".repeat(10_000);

    const chunks = chunkByChars(text, 300, 50);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
    expect(chunks.join("").length).toBeGreaterThanOrEqual(text.length);
  });
});

describe("checkForPromptInjection", () => {
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

  beforeEach(() => {
    mocks.generateObject.mockReset();
  });

  it("resolves true and records a clean verdict per chunk when every chunk scans", async () => {
    mocks.generateObject.mockResolvedValue(verdict(false));
    const costTracking = new CostTracking();

    await expect(run(costTracking)).resolves.toBe(true);
    expect(guardVerdicts(costTracking)).toEqual(["clean", "clean", "clean"]);
  });

  it("fails open and resolves false when one chunk's classifier call errors", async () => {
    mocks.generateObject
      .mockResolvedValueOnce(verdict(false))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(verdict(false));
    const costTracking = new CostTracking();

    await expect(run(costTracking)).resolves.toBe(false);
    expect(
      guardVerdicts(costTracking).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["clean", "clean", "none"]);
  });

  it("records a no-verdict call when the request was never dispatched", async () => {
    mocks.generateObject.mockRejectedValue(
      new LoadAPIKeyError({ message: "missing key" }),
    );
    const costTracking = new CostTracking();

    await expect(run(costTracking, "short page")).resolves.toBe(false);
    expect(guardVerdicts(costTracking)).toEqual(["none"]);
    expect(costTracking.toJSON().totalCost).toBe(0);
  });

  it("throws and records an injection verdict on a detection", async () => {
    mocks.generateObject.mockResolvedValue(verdict(true));
    const costTracking = new CostTracking();

    await expect(run(costTracking, "short page")).rejects.toBeInstanceOf(
      PromptInjectionDetectedError,
    );
    expect(guardVerdicts(costTracking)).toEqual(["injection"]);
  });

  it("keeps concurrent scans sharing a limiter within one guard's concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.generateObject.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => {
        setTimeout(resolve, 5);
      });
      inFlight--;
      return verdict(false);
    });
    const costTracking = new CostTracking();
    const limiter = createPromptInjectionGuardLimiter();

    // Four pages of three chunks each: 12 calls, 5 at most in flight.
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        checkForPromptInjection({
          markdown: threeChunkMarkdown,
          logger: noopLogger,
          costTracking,
          metadata: { teamId: "test-team" },
          zeroDataRetention: false,
          limiter,
        }),
      ),
    );

    expect(results).toEqual([true, true, true, true]);
    expect(mocks.generateObject).toHaveBeenCalledTimes(12);
    expect(maxInFlight).toBe(5);
  });

  it("tags every classifier span with the scrape and extract ids", async () => {
    mocks.generateObject.mockResolvedValue(verdict(false));

    await checkForPromptInjection({
      markdown: threeChunkMarkdown,
      logger: noopLogger,
      costTracking: new CostTracking(),
      metadata: {
        teamId: "test-team",
        scrapeId: "test-scrape",
        extractId: "test-extract",
      },
      zeroDataRetention: false,
    });

    const telemetry = mocks.generateObject.mock.calls.map(
      ([args]) => args.telemetry,
    );
    expect(telemetry).toHaveLength(3);
    for (const t of telemetry) {
      expect(t?.recordInputs).toBe(false);
      expect(t?.metadata).toEqual({
        teamId: "test-team",
        scrapeId: "test-scrape",
        extractId: "test-extract",
      });
    }
  });

  it("leaves job ids out of span metadata when the caller has none", async () => {
    mocks.generateObject.mockResolvedValue(verdict(false));

    await run(new CostTracking(), "short page");

    const [[args]] = mocks.generateObject.mock.calls;
    expect(args.telemetry?.metadata).toEqual({
      teamId: "test-team",
    });
  });

  it("resolves true without calling the classifier for empty content", async () => {
    const costTracking = new CostTracking();

    await expect(run(costTracking, "   ")).resolves.toBe(true);
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});
