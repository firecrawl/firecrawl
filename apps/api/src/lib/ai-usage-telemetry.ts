import { trace, type Attributes, type Span } from "@opentelemetry/api";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { xSearchUsageFromResponseBody } from "./xai-x-search";

type ProviderModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type ProviderResult = Awaited<ReturnType<ProviderModel["doGenerate"]>>;

// Runs inside the AI SDK's `ai.generateText.doGenerate` span (the SDK calls
// `model.doGenerate` with the span active) to record what the SDK does not.
const DO_GENERATE_SPAN_NAME = /^ai\.[A-Za-z]+\.doGenerate$/;

// With telemetry disabled the SDK uses a no-op tracer that does not set an
// active span, so the active span is whatever the caller had open. Only touch
// the SDK's own doGenerate span.
function activeDoGenerateSpan(): Span | undefined {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) {
    return undefined;
  }
  const name = (span as { name?: unknown }).name;
  return typeof name === "string" && DO_GENERATE_SPAN_NAME.test(name)
    ? span
    : undefined;
}

// Server-side tool fees the provider bills per item, which token counts
// cannot price. Only xAI X Search today.
function toolUsageTelemetryAttributes(result: ProviderResult): Attributes {
  const xSearch = xSearchUsageFromResponseBody(result.response?.body);
  if (!xSearch) {
    return {};
  }
  return {
    "firecrawl.llm.tool.x_search_posts": xSearch.posts,
    "firecrawl.llm.tool.x_search_profiles": xSearch.profiles,
  };
}

const usageTelemetryMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate }) => {
    const span = activeDoGenerateSpan();
    const result = await doGenerate();
    span?.setAttributes(toolUsageTelemetryAttributes(result));
    return result;
  },
};

export function withUsageTelemetry(model: ProviderModel): ProviderModel {
  return wrapLanguageModel({ model, middleware: usageTelemetryMiddleware });
}
