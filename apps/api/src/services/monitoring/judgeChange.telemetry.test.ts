import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  doGenerate: vi.fn(),
}));

// Call through to the real AI SDK so its telemetry spans are produced, while
// still letting the tests read the options each call was made with.
vi.mock("ai", async importOriginal => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(actual.generateText),
  };
});

// The judge model is built at import; stand in a mock provider model for it.
vi.mock("../../lib/generic-ai", async importOriginal => {
  const { MockLanguageModelV3 } = await import("ai/test");
  return {
    ...(await importOriginal<typeof import("../../lib/generic-ai")>()),
    getModel: (modelId: string) =>
      new MockLanguageModelV3({
        modelId,
        doGenerate: options => mocks.doGenerate(options),
      }),
  };
});

// Vertex is the production provider and the only one that takes billing labels.
vi.mock("../../config", async importOriginal => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: { ...actual.config, VERTEX_CREDENTIALS: btoa("{}") },
  };
});

import { context, propagation, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { generateText } from "ai";
import type { Mock } from "vitest";
import {
  createTracerProvider,
  withZeroDataRetention,
} from "../../lib/otel-tracer";
import { judgeChange } from "./judgeChange";

const LABELS = {
  teamId: "test-team",
  monitorId: "test-monitor",
  monitorCheckId: "test-check",
};

const MARKDOWN_DIFF = {
  diffText: "@@ -1 +1 @@\n-Pro plan: $19\n+Pro plan: $24",
};

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as any;

function providerResult(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "STOP" },
    usage: {
      inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: 0 },
      outputTokens: { total: 30, text: 22, reasoning: 8 },
    },
    warnings: [],
  };
}

const PRICE_CHANGED = JSON.stringify({
  meaningful: true,
  confidence: "high",
  reason: "The Pro price changed from '$19' to '$24'.",
  meaningfulChanges: [
    {
      type: "changed",
      before: "Pro plan: $19",
      after: "Pro plan: $24",
      reason: "The goal tracks the Pro price.",
    },
    // dropped: "added" must have a null before
    { type: "added", before: "x", after: "y", reason: "invalid" },
  ],
});

function judge(overrides: Partial<Parameters<typeof judgeChange>[0]> = {}) {
  return judgeChange({
    logger: noopLogger,
    goal: "Track the Pro plan price",
    markdownDiff: MARKDOWN_DIFF,
    labels: LABELS,
    zeroDataRetention: false,
    ...overrides,
  });
}

function telemetryOfCalls() {
  return (generateText as Mock).mock.calls.map(
    ([options]) => options.experimental_telemetry,
  );
}

describe("judgeChange telemetry", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;

  beforeAll(() => {
    provider = createTracerProvider({ exporter, serviceName: "test-service" });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  beforeEach(async () => {
    // Flush first so a span the last test left unexported isn't counted here.
    await provider.forceFlush();
    exporter.reset();
    (generateText as Mock).mockClear();
    mocks.doGenerate.mockReset();
    mocks.doGenerate.mockResolvedValue(providerResult(PRICE_CHANGED));
    // Shortest retry backoff, so the retry tests stay quick.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function doGenerateSpans() {
    await provider.forceFlush();
    return exporter
      .getFinishedSpans()
      .filter(span => span.name === "ai.generateText.doGenerate");
  }

  it("tags the provider call span with the monitor check and token breakdown", async () => {
    await judge();

    const spans = await doGenerateSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({
      "ai.telemetry.functionId": "monitor/judgeChange",
      "ai.telemetry.metadata.teamId": "test-team",
      "ai.telemetry.metadata.monitorId": "test-monitor",
      "ai.telemetry.metadata.jobId": "test-check",
      "ai.telemetry.metadata.jobKind": "monitor",
      "ai.telemetry.metadata.feature": "monitor_judge",
      "ai.usage.cachedInputTokens": 100,
      "ai.usage.reasoningTokens": 8,
    });
  });

  it("keeps the Vertex billing labels", async () => {
    await judge();

    expect(mocks.doGenerate).toHaveBeenCalledTimes(1);
    expect(mocks.doGenerate.mock.calls[0][0].providerOptions).toEqual({
      vertex: {
        thinkingConfig: { thinkingLevel: "minimal" },
        labels: { functionId: "judgeChange", ...LABELS },
      },
    });
  });

  it("records one span per attempt when a call is retried", async () => {
    mocks.doGenerate
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(providerResult(PRICE_CHANGED));

    const result = await judge();

    expect(result.meaningful).toBe(true);
    const spans = await doGenerateSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.attributes["ai.telemetry.metadata.jobId"]).toBe("test-check");
    }
  });

  it("turns off telemetry for a zero data retention call", async () => {
    await judge({ zeroDataRetention: true });

    expect(telemetryOfCalls()).toEqual([
      expect.objectContaining({ isEnabled: false }),
    ]);
    expect(await doGenerateSpans()).toEqual([]);
  });

  it("turns off telemetry in a zero data retention context without the flag", async () => {
    await withZeroDataRetention(true, () =>
      judge({ zeroDataRetention: undefined }),
    );

    expect(telemetryOfCalls()).toEqual([
      expect.objectContaining({ isEnabled: false }),
    ]);
    expect(await doGenerateSpans()).toEqual([]);
  });
});

function contradictoryVerdict(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    meaningful: true,
    confidence: "high",
    reason: "There are no meaningful new announcements added.",
    meaningfulChanges: [],
    ...overrides,
  });
}

function capturingLogger() {
  const warnings: Array<{ message: string; meta?: unknown }> = [];
  const logger = {
    warn: (message: string, meta?: unknown) => {
      warnings.push({ message, meta });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return logger;
    },
  };
  return { logger: logger as any, warnings };
}

function assertLogsOmitEvidence(
  warnings: Array<{ message: string; meta?: unknown }>,
) {
  const serialized = JSON.stringify(warnings);
  expect(serialized).not.toContain("Pro plan");
  expect(serialized).not.toContain("Track the Pro plan price");
  expect(serialized).not.toContain("capture the price table");
  expect(serialized).not.toContain("no meaningful new announcements");
}

describe("judgeChange behaviour", () => {
  beforeEach(() => {
    mocks.doGenerate.mockReset();
    (generateText as Mock).mockClear();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed judgment, keeping only valid change events", async () => {
    mocks.doGenerate.mockResolvedValue(providerResult(PRICE_CHANGED));

    expect(await judge()).toEqual({
      meaningful: true,
      confidence: "high",
      reason: "The Pro price changed from '$19' to '$24'.",
      meaningfulChanges: [
        {
          type: "changed",
          before: "Pro plan: $19",
          after: "Pro plan: $24",
          reason: "The goal tracks the Pro price.",
        },
      ],
    });
    expect(mocks.doGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not let reason wording override a true verdict that still has a valid change", async () => {
    mocks.doGenerate.mockResolvedValue(
      providerResult(
        JSON.stringify({
          meaningful: true,
          confidence: "high",
          reason: "There are no meaningful new announcements added.",
          meaningfulChanges: [
            {
              type: "changed",
              before: "Pro plan: $19",
              after: "Pro plan: $24",
              reason: "The goal tracks the Pro price.",
            },
          ],
        }),
      ),
    );

    const result = await judge();

    expect(mocks.doGenerate).toHaveBeenCalledTimes(1);
    expect(result.meaningful).toBe(true);
    expect(result.meaningfulChanges).toHaveLength(1);
  });

  it("defaults to meaningful when the response is not JSON", async () => {
    mocks.doGenerate.mockResolvedValue(providerResult("no idea"));

    expect(await judge()).toMatchObject({
      meaningful: true,
      confidence: "low",
      meaningfulChanges: [],
    });
  });

  it("defaults to meaningful after every attempt fails", async () => {
    mocks.doGenerate.mockRejectedValue(new Error("provider unavailable"));

    const result = await judge();

    expect(mocks.doGenerate).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ meaningful: true, confidence: "low" });
    expect(result.reason).toContain("provider unavailable");
  });

  it("makes no call without a diff", async () => {
    await judge({ markdownDiff: undefined });

    expect(mocks.doGenerate).not.toHaveBeenCalled();
  });

  it("retries when every change entry is removed by sanitization", async () => {
    const { logger, warnings } = capturingLogger();
    mocks.doGenerate
      .mockResolvedValueOnce(
        providerResult(
          contradictoryVerdict({
            meaningfulChanges: [
              {
                type: "added",
                before: "x",
                after: "y",
                reason: "invalid pair",
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(providerResult(PRICE_CHANGED));

    const result = await judge({
      logger,
      extractionPrompt: "capture the price table",
    });

    expect(mocks.doGenerate).toHaveBeenCalledTimes(2);
    expect(result.meaningful).toBe(true);
    expect(result.meaningfulChanges).toEqual([
      {
        type: "changed",
        before: "Pro plan: $19",
        after: "Pro plan: $24",
        reason: "The goal tracks the Pro price.",
      },
    ]);
    const retryBlob = JSON.stringify(mocks.doGenerate.mock.calls[1][0]);
    expect(retryBlob).toContain("MONITOR GOAL");
    expect(retryBlob).toContain("Track the Pro plan price");
    expect(retryBlob).toContain("Pro plan: $19");
    expect(retryBlob).toContain("capture the price table");
    expect(retryBlob).toContain("no valid meaningfulChanges remained");
    expect(mocks.doGenerate.mock.calls[1][0].providerOptions).toEqual({
      vertex: {
        thinkingConfig: { thinkingLevel: "minimal" },
        labels: { functionId: "judgeChangeValidationRetry", ...LABELS },
      },
    });
    expect(telemetryOfCalls()[1]).toMatchObject({
      functionId: "monitor/judgeChangeValidationRetry",
      metadata: expect.objectContaining({
        jobId: "test-check",
        feature: "monitor_judge_validation_retry",
      }),
    });
    expect(warnings.map(warning => warning.message)).toEqual([
      "Judge validation failed; retrying once",
    ]);
    assertLogsOmitEvidence(warnings);
  });

  it("accepts a retry that returns meaningful false", async () => {
    const { logger, warnings } = capturingLogger();
    mocks.doGenerate
      .mockResolvedValueOnce(providerResult(contradictoryVerdict()))
      .mockResolvedValueOnce(
        providerResult(
          JSON.stringify({
            meaningful: false,
            confidence: "medium",
            reason: "There are no meaningful new announcements added.",
            meaningfulChanges: [
              { type: "added", before: "x", after: "y", reason: "invalid" },
            ],
          }),
        ),
      );

    const result = await judge({ logger });

    expect(mocks.doGenerate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      meaningful: false,
      confidence: "medium",
      meaningfulChanges: [],
    });
    expect(warnings).toHaveLength(1);
    assertLogsOmitEvidence(warnings);
  });

  it("fails open when the validation retry is still contradictory", async () => {
    const { logger, warnings } = capturingLogger();
    mocks.doGenerate.mockResolvedValue(providerResult(contradictoryVerdict()));

    const result = await judge({ logger });

    expect(mocks.doGenerate).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      meaningful: true,
      confidence: "high",
      reason: "There are no meaningful new announcements added.",
      meaningfulChanges: [],
    });
    expect(warnings.map(warning => warning.message)).toEqual([
      "Judge validation failed; retrying once",
      "Judge validation retry was still invalid; failing open",
    ]);
    expect(warnings[1].meta).toMatchObject({
      validation: "meaningful_without_changes",
      outcome: "contradictory",
    });
    assertLogsOmitEvidence(warnings);
  });

  it("fails open when the validation retry errors", async () => {
    const { logger, warnings } = capturingLogger();
    mocks.doGenerate
      .mockResolvedValueOnce(providerResult(contradictoryVerdict()))
      .mockRejectedValue(new Error("provider unavailable"));

    const result = await judge({ logger });

    expect(mocks.doGenerate).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ meaningful: true, confidence: "low" });
    expect(result.reason).toContain("provider unavailable");
    expect(warnings.map(warning => warning.message)).toEqual([
      "Judge validation failed; retrying once",
      "Judge validation retry failed; failing open",
    ]);
    expect(warnings[1].meta).toEqual({
      validation: "meaningful_without_changes",
      errorName: "Error",
    });
    assertLogsOmitEvidence(warnings);
  });

  it("fails open when the validation retry is unparseable", async () => {
    const { logger, warnings } = capturingLogger();
    mocks.doGenerate
      .mockResolvedValueOnce(providerResult(contradictoryVerdict()))
      .mockResolvedValueOnce(
        providerResult("no idea, the diff was Pro plan: $19"),
      );

    const result = await judge({ logger });

    expect(mocks.doGenerate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      meaningful: true,
      confidence: "low",
      reason: "Judge response unparseable — defaulting to meaningful.",
      meaningfulChanges: [],
    });
    expect(warnings.map(warning => warning.message)).toEqual([
      "Judge validation failed; retrying once",
      "Judge returned unparseable response",
      "Judge validation retry was still invalid; failing open",
    ]);
    expect(warnings[2].meta).toMatchObject({ outcome: "unparseable" });
    assertLogsOmitEvidence(warnings);
  });

  it("fails open when the validation retry is not valid JSON", async () => {
    const { logger, warnings } = capturingLogger();
    mocks.doGenerate
      .mockResolvedValueOnce(providerResult(contradictoryVerdict()))
      .mockResolvedValueOnce(
        providerResult('{ "meaningful": true, "reason": "Pro plan: $19", }'),
      );

    const result = await judge({ logger });

    expect(mocks.doGenerate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      meaningful: true,
      confidence: "low",
      reason: "Judge response not valid JSON — defaulting to meaningful.",
      meaningfulChanges: [],
    });
    expect(warnings.map(warning => warning.message)).toEqual([
      "Judge validation failed; retrying once",
      "Judge JSON parse failed — defaulting to meaningful",
      "Judge validation retry was still invalid; failing open",
    ]);
    expect(warnings[1].meta).toEqual({});
    expect(warnings[2].meta).toMatchObject({ outcome: "unparseable" });
    assertLogsOmitEvidence(warnings);
  });

  it("does not retry when the meaningful boolean is missing", async () => {
    mocks.doGenerate.mockResolvedValue(
      providerResult(
        JSON.stringify({
          confidence: "high",
          reason: "There are no meaningful new announcements added.",
          meaningfulChanges: [],
        }),
      ),
    );

    const result = await judge();

    expect(mocks.doGenerate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      meaningful: true,
      meaningfulChanges: [],
    });
  });
});
