import { LegacyOpenTelemetry } from "@ai-sdk/otel";
import { trace } from "@opentelemetry/api";
import type { Attributes, AttributeValue, Tracer } from "@opentelemetry/api";
import type { TelemetryOptions } from "ai";

type AiTelemetryOptions = {
  isEnabled: boolean;
  functionId?: string;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  /** Recorded on the call's spans as `ai.telemetry.metadata.<key>`. */
  metadata?: Record<string, AttributeValue | undefined>;
};

// AI SDK 7 reports token totals as `ai.usage.inputTokens` / `outputTokens`.
// Keep the names earlier versions used alongside, so spans from before and
// after the upgrade can be queried alike.
function withLegacyUsageNames(attributes: Attributes): Attributes {
  return {
    ...attributes,
    ...(attributes["ai.usage.inputTokens"] !== undefined && {
      "ai.usage.promptTokens": attributes["ai.usage.inputTokens"],
    }),
    ...(attributes["ai.usage.outputTokens"] !== undefined && {
      "ai.usage.completionTokens": attributes["ai.usage.outputTokens"],
    }),
  };
}

function callTracer(metadata: AiTelemetryOptions["metadata"]): Tracer {
  const tracer = trace.getTracer("ai");
  const metadataAttributes: Attributes = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) {
      metadataAttributes[`ai.telemetry.metadata.${key}`] = value;
    }
  }
  return {
    startSpan: (name, options, context) => {
      const span = tracer.startSpan(
        name,
        {
          ...options,
          attributes: { ...options?.attributes, ...metadataAttributes },
        },
        context,
      );
      const setAttributes = span.setAttributes.bind(span);
      span.setAttributes = attributes =>
        setAttributes(withLegacyUsageNames(attributes));
      return span;
    },
    startActiveSpan: tracer.startActiveSpan.bind(tracer),
  };
}

/**
 * The `telemetry` option for an AI SDK call. No integration is registered
 * globally, so a call emits spans only when it passes this with `isEnabled`
 * true. The AI SDK no longer takes per-call metadata, so it is stamped here.
 */
export function aiTelemetry({
  metadata,
  ...options
}: AiTelemetryOptions): TelemetryOptions {
  if (!options.isEnabled) {
    return { isEnabled: false, integrations: [] };
  }
  return {
    ...options,
    integrations: new LegacyOpenTelemetry({ tracer: callTracer(metadata) }),
  };
}
