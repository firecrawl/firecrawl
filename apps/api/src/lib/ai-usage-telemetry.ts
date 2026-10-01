import { trace, type Attributes, type Span } from "@opentelemetry/api";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { xSearchUsageFromResponseBody } from "./xai-x-search";

type ProviderModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type ProviderResult = Awaited<ReturnType<ProviderModel["doGenerate"]>>;
type ProviderUsage = ProviderResult["usage"];

// The AI SDK's `ai.generateObject.doGenerate` and `ai.generateText.doGenerate`
// spans only record prompt and completion token totals, so cache reads and
// reasoning tokens reported by the provider never reach the trace. This
// middleware runs inside those spans (the SDK calls `model.doGenerate` with
// the span active) and adds the missing usage breakdown under the attribute
// names newer SDK versions use for `generateText`. Streaming spans
// (`ai.*.doStream`) already carry `ai.usage.cachedInputTokens` and
// `ai.usage.reasoningTokens`.
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

function usageTelemetryAttributes(usage: ProviderUsage): Attributes {
  const attributes: Record<string, number | undefined> = {
    "ai.usage.cachedInputTokens": usage.inputTokens.cacheRead,
    "ai.usage.reasoningTokens": usage.outputTokens.reasoning,
    "ai.usage.inputTokenDetails.noCacheTokens": usage.inputTokens.noCache,
    "ai.usage.inputTokenDetails.cacheReadTokens": usage.inputTokens.cacheRead,
    "ai.usage.inputTokenDetails.cacheWriteTokens": usage.inputTokens.cacheWrite,
    "ai.usage.outputTokenDetails.textTokens": usage.outputTokens.text,
    "ai.usage.outputTokenDetails.reasoningTokens": usage.outputTokens.reasoning,
  };
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined),
  );
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
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate }) => {
    const span = activeDoGenerateSpan();
    const result = await doGenerate();
    span?.setAttributes({
      ...usageTelemetryAttributes(result.usage),
      ...toolUsageTelemetryAttributes(result),
    });
    return result;
  },
};

export function withUsageTelemetry(model: ProviderModel): ProviderModel {
  return wrapLanguageModel({ model, middleware: usageTelemetryMiddleware });
}
