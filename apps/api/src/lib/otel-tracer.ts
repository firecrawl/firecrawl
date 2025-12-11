import * as Sentry from "@sentry/node";
import type { Span } from "@sentry/node";
import type { SpanAttributeValue, SpanAttributes } from "@sentry/core";

export enum SpanKind {
  INTERNAL = 0,
  SERVER = 1,
  CLIENT = 2,
  PRODUCER = 3,
  CONSUMER = 4,
}

const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;

export interface SerializedTraceContext {
  sentryTrace?: string;
  baggage?: string;
}

export function serializeTraceContext(): SerializedTraceContext {
  const traceData = Sentry.getTraceData();

  return {
    sentryTrace: traceData["sentry-trace"],
    baggage: traceData["baggage"],
  };
}

export async function withTraceContextAsync<T>(
  serializedContext: SerializedTraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!serializedContext.sentryTrace) {
    return fn();
  }

  return Sentry.continueTrace(
    {
      sentryTrace: serializedContext.sentryTrace,
      baggage: serializedContext.baggage,
    },
    fn,
  );
}

type Attributes = SpanAttributes;

interface SpanOptions {
  attributes?: Attributes;
  kind?: SpanKind;
  op?: string;
}

function spanKindToOp(kind?: SpanKind): string | undefined {
  switch (kind) {
    case SpanKind.SERVER:
      return "http.server";
    case SpanKind.CLIENT:
      return "http.client";
    case SpanKind.PRODUCER:
      return "queue.publish";
    case SpanKind.CONSUMER:
      return "queue.process";
    case SpanKind.INTERNAL:
    default:
      return undefined;
  }
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
): Promise<T> {
  const op = options?.op || spanKindToOp(options?.kind);

  return Sentry.startSpan(
    {
      name,
      op,
      attributes: options?.attributes,
    },
    async span => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SPAN_STATUS_OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SPAN_STATUS_ERROR,
          message: error instanceof Error ? error.message : String(error),
        });

        if (error instanceof Error) {
          Sentry.captureException(error);
        }

        throw error;
      }
    },
  );
}

export function setSpanAttributes(span: Span, attributes: Attributes): void {
  Object.entries(attributes).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      span.setAttribute(key, value as SpanAttributeValue);
    }
  });
}
