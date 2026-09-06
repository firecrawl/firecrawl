import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import {
  createTracerProvider,
  serializeTraceContext,
  setSpanAttributes,
  SpanKind,
  withSpan,
  withTraceContextAsync,
  withZeroDataRetention,
  type SerializedTraceContext,
} from "./otel-tracer";

describe("otel-tracer", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;
  // The provider's env detector reads these; keep the suite hermetic.
  const savedEnv = {
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
    OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
  };

  beforeAll(() => {
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    provider = createTracerProvider({
      exporter,
      serviceName: "test-service",
      serviceInstanceId: "pod-1",
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    exporter.reset();
  });

  async function exportedSpans() {
    await provider.forceFlush();
    return exporter.getFinishedSpans();
  }

  it("exports spans with kind, attributes, status, and resource", async () => {
    const result = await withSpan(
      "test.root",
      async span => {
        setSpanAttributes(span, {
          "a.string": "x",
          "a.number": 1,
          "a.undefined": undefined,
          "a.null": null,
        });
        return 42;
      },
      { kind: SpanKind.SERVER, attributes: { initial: true } },
    );

    expect(result).toBe(42);
    const spans = await exportedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("test.root");
    expect(spans[0].kind).toBe(SpanKind.SERVER);
    expect(spans[0].attributes).toEqual({
      initial: true,
      "a.string": "x",
      "a.number": 1,
    });
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    expect(spans[0].resource.attributes["service.name"]).toBe("test-service");
    expect(spans[0].resource.attributes["service.instance.id"]).toBe("pod-1");
  });

  it("records the exception, marks the span as errored, and rethrows", async () => {
    await expect(
      withSpan("test.fail", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const [span] = await exportedSpans();
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(span.events.map(event => event.name)).toContain("exception");
  });

  it("parents nested and library spans under the active span", async () => {
    await withSpan("test.parent", async () => {
      await withSpan("test.child", async () => {});
      // The AI SDK reports through the global tracer, like this.
      trace.getTracer("ai").startSpan("ai.generateText").end();
    });

    const spans = await exportedSpans();
    const parent = spans.find(span => span.name === "test.parent")!;
    expect(spans.map(span => span.name).sort()).toEqual([
      "ai.generateText",
      "test.child",
      "test.parent",
    ]);
    for (const span of spans.filter(span => span !== parent)) {
      expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    }
  });

  it("records nothing started under zero data retention", async () => {
    await withSpan(
      "zdr.root",
      async span => {
        expect(span.isRecording()).toBe(false);
        await withSpan("zdr.child", async () => {});
        trace.getTracer("ai").startSpan("ai.generateText").end();
      },
      { zeroDataRetention: true },
    );
    await withZeroDataRetention(true, () =>
      withSpan("zdr.nested", async () => {}),
    );
    await withSpan("kept.root", async () => {}, { zeroDataRetention: false });

    expect((await exportedSpans()).map(span => span.name)).toEqual([
      "kept.root",
    ]);
  });

  it("drops spans that end with a zero_data_retention attribute", async () => {
    await withSpan("attr.dropped", async span => {
      setSpanAttributes(span, { "nuq.zero_data_retention": true });
    });
    await withSpan("attr.kept", async span => {
      setSpanAttributes(span, { "nuq.zero_data_retention": false });
    });

    expect((await exportedSpans()).map(span => span.name)).toEqual([
      "attr.kept",
    ]);
  });

  it("continues a serialized trace and inherits the sampled decision", async () => {
    let serialized: SerializedTraceContext = {};
    let apiSpanId = "";
    let traceId = "";
    await withSpan("api.request", async span => {
      serialized = serializeTraceContext();
      apiSpanId = span.spanContext().spanId;
      traceId = span.spanContext().traceId;
    });
    expect(serialized.traceparent).toBe(`00-${traceId}-${apiSpanId}-01`);

    await withTraceContextAsync(serialized, () =>
      withSpan("worker.process", async () => {}),
    );

    const worker = (await exportedSpans()).find(
      span => span.name === "worker.process",
    )!;
    expect(worker.spanContext().traceId).toBe(traceId);
    expect(worker.parentSpanContext?.spanId).toBe(apiSpanId);
  });

  it("keeps a continued zero-data-retention trace unrecorded", async () => {
    let serialized: SerializedTraceContext = {};
    await withSpan(
      "api.zdr",
      async () => {
        serialized = serializeTraceContext();
      },
      { zeroDataRetention: true },
    );
    expect(serialized.traceparent).toMatch(/-00$/);

    await withTraceContextAsync(serialized, () =>
      withSpan("worker.process", async () => {}),
    );

    expect(await exportedSpans()).toHaveLength(0);
  });

  it("starts a fresh trace for missing or legacy serialized contexts", async () => {
    await withTraceContextAsync(undefined, () =>
      withSpan("worker.none", async () => {}),
    );
    await withTraceContextAsync(
      { sentryTrace: "legacy" } as unknown as SerializedTraceContext,
      () => withSpan("worker.legacy", async () => {}),
    );

    const spans = await exportedSpans();
    expect(spans.map(span => span.name).sort()).toEqual([
      "worker.legacy",
      "worker.none",
    ]);
    for (const span of spans) {
      expect(span.parentSpanContext).toBeUndefined();
    }
  });

  it("serializes an empty context outside of a span", () => {
    expect(serializeTraceContext()).toEqual({});
  });
});
