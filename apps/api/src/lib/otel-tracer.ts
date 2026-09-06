import {
  context,
  createContextKey,
  isSpanContextValid,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  SamplingDecision,
  type ReadableSpan,
  type Sampler,
  type SamplingResult,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export { SpanKind } from "@opentelemetry/api";
export type { Span } from "@opentelemetry/api";

const TRACER_NAME = "firecrawl-api";

// Zero data retention (ZDR) spans must never leave the process. Two layers
// enforce that:
//  1. `withZeroDataRetention` flags the active context; the sampler turns every
//     span started under it (our own and library spans such as the AI SDK's)
//     into a non-recording span, so nothing is even buffered.
//  2. Any span that ends carrying a `zero_data_retention` /
//     `*.zero_data_retention` attribute set to `true` is dropped before export,
//     covering spans that only learn about ZDR after they started.
const ZERO_DATA_RETENTION_CONTEXT_KEY = createContextKey(
  "firecrawl.zero_data_retention",
);

export function withZeroDataRetention<T>(
  zeroDataRetention: boolean | undefined,
  fn: () => T,
): T {
  if (!zeroDataRetention) {
    return fn();
  }

  return context.with(
    context.active().setValue(ZERO_DATA_RETENTION_CONTEXT_KEY, true),
    fn,
  );
}

function isZeroDataRetentionContext(ctx: Context): boolean {
  return ctx.getValue(ZERO_DATA_RETENTION_CONTEXT_KEY) === true;
}

// Traces flagged ZDR after their root span started (a `*.zero_data_retention`
// attribute set from inside a *recording* span). Descendants started afterwards
// are not recorded and spans of these traces still in flight are dropped when
// they end. Only recording spans register here: a non-recording span already
// suppresses its descendants through parent-based sampling, so the registry
// only sees the rare late-discovery case and stays far below its cap. The cap
// is a memory guard, not an expected steady state.
const ZERO_DATA_RETENTION_TRACE_LIMIT = 100_000;
const zeroDataRetentionTraces = new Set<string>();

function markTraceZeroDataRetention(traceId: string): void {
  if (zeroDataRetentionTraces.has(traceId)) {
    return;
  }

  zeroDataRetentionTraces.add(traceId);
  if (zeroDataRetentionTraces.size > ZERO_DATA_RETENTION_TRACE_LIMIT) {
    const oldest = zeroDataRetentionTraces.values().next().value;
    if (oldest !== undefined) {
      zeroDataRetentionTraces.delete(oldest);
    }
  }
}

function hasZeroDataRetentionAttribute(attributes: Attributes): boolean {
  for (const [key, value] of Object.entries(attributes)) {
    if (
      value === true &&
      (key === "zero_data_retention" || key.endsWith(".zero_data_retention"))
    ) {
      return true;
    }
  }

  return false;
}

class ZeroDataRetentionSampler implements Sampler {
  constructor(private readonly delegate: Sampler) {}

  shouldSample(
    ctx: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (hasZeroDataRetentionAttribute(attributes)) {
      markTraceZeroDataRetention(traceId);
      return { decision: SamplingDecision.NOT_RECORD };
    }

    if (
      isZeroDataRetentionContext(ctx) ||
      zeroDataRetentionTraces.has(traceId)
    ) {
      return { decision: SamplingDecision.NOT_RECORD };
    }

    return this.delegate.shouldSample(
      ctx,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
  }

  toString(): string {
    return `ZeroDataRetentionSampler(${this.delegate.toString()})`;
  }
}

class ZeroDataRetentionSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(
    span: Parameters<SpanProcessor["onStart"]>[0],
    parentContext: Context,
  ): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    if (hasZeroDataRetentionAttribute(span.attributes)) {
      markTraceZeroDataRetention(traceId);
      return;
    }

    if (zeroDataRetentionTraces.has(traceId)) {
      return;
    }

    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

interface TracerProviderOptions {
  exporter: SpanExporter;
  serviceName: string;
  serviceInstanceId?: string;
}

/**
 * Builds the tracer provider used by every Firecrawl process: 100% sampling
 * (respecting the sampled flag of a remote parent), ZDR filtering, and batched
 * export. Callers decide whether to `register()` it globally.
 */
export function createTracerProvider(
  options: TracerProviderOptions,
): NodeTracerProvider {
  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        ...(options.serviceInstanceId
          ? { "service.instance.id": options.serviceInstanceId }
          : {}),
      }),
    );

  return new NodeTracerProvider({
    resource,
    sampler: new ZeroDataRetentionSampler(
      new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    ),
    spanProcessors: [
      new ZeroDataRetentionSpanProcessor(
        new BatchSpanProcessor(options.exporter),
      ),
    ],
  });
}

/**
 * W3C trace context carrier, stored on queue jobs so a worker can continue the
 * trace the API request started.
 */
export interface SerializedTraceContext {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

export function serializeTraceContext(): SerializedTraceContext {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);

  const serialized: SerializedTraceContext = {};
  if (carrier.traceparent) serialized.traceparent = carrier.traceparent;
  if (carrier.tracestate) serialized.tracestate = carrier.tracestate;
  if (carrier.baggage) serialized.baggage = carrier.baggage;
  return serialized;
}

export async function withTraceContextAsync<T>(
  serializedContext: SerializedTraceContext | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!serializedContext?.traceparent) {
    return fn();
  }

  const carrier: Record<string, string> = {
    traceparent: serializedContext.traceparent,
  };
  if (serializedContext.tracestate) {
    carrier.tracestate = serializedContext.tracestate;
  }
  if (serializedContext.baggage) {
    carrier.baggage = serializedContext.baggage;
  }

  return context.with(propagation.extract(context.active(), carrier), fn);
}

type SpanAttributeInput = Record<string, AttributeValue | null | undefined>;

function cleanAttributes(
  attributes: SpanAttributeInput | undefined,
): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const cleaned: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

interface SpanOptions {
  attributes?: SpanAttributeInput;
  kind?: SpanKind;
  /**
   * Marks the span and everything started inside it as zero data retention:
   * nothing is recorded or exported.
   */
  zeroDataRetention?: boolean;
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);

  return withZeroDataRetention(options?.zeroDataRetention, () =>
    tracer.startActiveSpan(
      name,
      { kind: options?.kind, attributes: cleanAttributes(options?.attributes) },
      async span => {
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          recordSpanException(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    ),
  );
}

/**
 * Marks a span as failed and attaches the error as an exception event, for
 * failures that are handled (returned) rather than thrown out of `withSpan`.
 */
export function recordSpanException(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
}

export function setSpanAttributes(
  span: Span,
  attributes: SpanAttributeInput,
): void {
  const cleaned = cleanAttributes(attributes);
  if (!cleaned) {
    return;
  }

  span.setAttributes(cleaned);

  // Flagging a live, recording span as ZDR also covers everything started under
  // it from now on, plus spans of the trace that are still in flight. A
  // non-recording span needs no registry entry: its descendants are already
  // dropped by parent-based sampling.
  const spanContext = span.spanContext();
  if (
    span.isRecording() &&
    hasZeroDataRetentionAttribute(cleaned) &&
    isSpanContextValid(spanContext)
  ) {
    markTraceZeroDataRetention(spanContext.traceId);
  }
}
