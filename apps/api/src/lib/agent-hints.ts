/** Response-only heuristics: no inference, I/O, or task/session state. */
export type AgentHintEndpoint = "search" | "scrape" | "parse" | "map";
export interface AgentHintContext {
  endpoint: AgentHintEndpoint;
  response: unknown;
  /** Set only by a controller that created a feedback-supported job. */
  feedbackJobId?: string;
  searchFeedbackMaxAgeSec?: number;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function feedbackHint(context: AgentHintContext): string | undefined {
  if (!context.feedbackJobId || object(context.response).success !== true)
    return;
  const identity = JSON.stringify({
    endpoint: context.endpoint,
    jobId: context.feedbackJobId,
  });
  const prefix = `After evaluating this ${context.endpoint} result, submit feedback once via POST /v2/feedback. Use ${identity}, add rating chosen honestly from good, partial, or bad, and add evidence. `;
  if (context.endpoint === "search") {
    const window =
      context.searchFeedbackMaxAgeSec && context.searchFeedbackMaxAgeSec > 0
        ? ` Submit within ${context.searchFeedbackMaxAgeSec} seconds of this search.`
        : "";
    return (
      prefix +
      `For good, include valuableSources:[{url,reason}]; for partial, include valuableSources or missingContent:[{topic,description}]; for bad, include missingContent or querySuggestions. Report useful sources as well as missing, stale, or irrelevant information; do not rate success from the HTTP status alone. Add metadata:{"assessmentSource":"agent"} for an agent assessment.` +
      window
    );
  }
  return (
    prefix +
    'Include note with what was useful and what was missing or incorrect. An optional metadata:{"assessmentSource":"agent"} identifies an agent assessment. Do not submit again for a retry of this same job.'
  );
}

export function buildAgentHints(context: AgentHintContext): string[] {
  const response = object(context.response);
  const data = object(response.data);
  let crossEndpoint: string | undefined;
  if (response.success === true) {
    const pageStatus = object(data.metadata).statusCode;
    if (
      context.endpoint === "scrape" &&
      (pageStatus === 404 || pageStatus === 410)
    ) {
      crossEndpoint =
        'The source page returned 404 or 410. If you need its current location or an alternative, use POST /v2/search with {"query":"<page name or subject>","sources":["web"]}. Use the page identity from your task; this is not a transient-error retry.';
    } else if (context.endpoint === "search") {
      const web = Array.isArray(response.data)
        ? response.data
        : array(data.web);
      if (
        web.some(value => {
          const item = object(value);
          return (
            typeof item.url === "string" &&
            !item.markdown &&
            !item.html &&
            !item.rawHtml
          );
        })
      ) {
        crossEndpoint =
          'Some web results have no full page content. If you need more than an excerpt, use POST /v2/scrape with {"url":"<selected result URL>","formats":["markdown"]}. Retrieve only needed pages; do not re-scrape results that already contain the required content.';
      }
    }
  }

  const feedback = feedbackHint(context);
  return [crossEndpoint, feedback]
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, hints) => hints.indexOf(hint) === index)
    .slice(0, 2);
}
