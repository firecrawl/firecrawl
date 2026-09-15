/** Response-only heuristics: no inference, I/O, or task/session state. */
export type AgentHintEndpoint = "search" | "scrape" | "parse" | "map";
export interface AgentHintContext {
  endpoint: AgentHintEndpoint;
  request?: unknown;
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
function isCall(value: unknown): boolean {
  const call = object(value);
  return (
    typeof call.provider === "string" &&
    typeof call.capability === "string" &&
    (call.options === undefined ||
      (call.options !== null &&
        typeof call.options === "object" &&
        !Array.isArray(call.options)))
  );
}
function fullDefinition(value: unknown): boolean {
  const tool = object(value);
  return Array.isArray(tool.options) && !!(tool.response || tool.returns);
}

const inspectTools =
  'Alexandria tool definitions are included. Inspect those matching your task, including required inputs and supported operations; execute a selected tool with POST /v2/scrape and {"alexandria":{"provider":"<tool provider>","capability":"<tool capability>","options":{"<input name>":"<value from your task>"}}}. Replace placeholders using its definition; do not assume a domain match supports your task.';
const expandTool =
  'These are tool summaries. For a tool matching your task, send POST /v2/scrape with {"alexandria": <that item\'s next object>} to obtain its full input and output definitions before execution.';
const pageTools =
  'More tools are available in this catalogue lookup. If the items shown do not cover your task, send POST /v2/scrape with {"alexandria": <this catalogue page\'s next object>}. This fetches another catalogue page, not provider records.';
const searchWeb =
  'This catalogue lookup returned no tools and no next page. If it does not cover your task, use POST /v2/search with {"query":"<remaining research need>","sources":["web"]}; this does not imply that every Alexandria provider was searched.';

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
  const request = object(context.request);
  const providerResults = array(data.alexandria);
  let crossEndpoint: string | undefined;
  let resultStep: string | undefined;

  // A typed upstream rejection must not be disguised as a successful workflow.
  const providerError = providerResults
    .map(object)
    .find(result => result.error);
  const typedError = providerError
    ? object(providerError.error)
    : response.success === false
      ? object(typeof response.error === "object" ? response.error : response)
      : undefined;
  if (typedError) {
    const calls = Array.isArray(request.alexandria)
      ? request.alexandria
      : [request.alexandria];
    const invalidQuery = calls
      .map(object)
      .find(
        call =>
          call.provider === "firecrawl" &&
          call.capability === "find-tools" &&
          typeof object(call.options).query === "string",
      );
    if (typedError.code === "invalid_option" && invalidQuery) {
      const query = String(object(invalidQuery.options).query).slice(0, 500);
      resultStep = `Find Tools does not accept query. For free-text discovery use POST /v2/search with ${JSON.stringify({ query, sources: ["alexandria"] })}. For provider filters, use the accepted options listed in the error before retrying.`;
    }
  } else if (response.success === true) {
    const tools = array(data.tools);
    const catalogues = providerResults
      .map(object)
      .filter(
        result =>
          result.provider === "firecrawl" && result.capability === "find-tools",
      )
      .map(result => object(result.data));
    const catalogueItems = catalogues.flatMap(catalogue =>
      array(catalogue.items),
    );
    const summaries = [...tools, ...catalogueItems].some(
      tool => !fullDefinition(tool) && isCall(object(tool).next),
    );
    if (summaries) resultStep = expandTool;
    else if (catalogues.some(catalogue => isCall(catalogue.next)))
      resultStep = pageTools;

    const pageStatus = object(data.metadata).statusCode;
    if (
      context.endpoint === "scrape" &&
      (pageStatus === 404 || pageStatus === 410)
    ) {
      crossEndpoint =
        'The source page returned 404 or 410. If you need its current location or an alternative, use POST /v2/search with {"query":"<page name or subject>","sources":["web"]}. Use the page identity from your task; this is not a transient-error retry.';
      resultStep = undefined;
    } else if ([...tools, ...catalogueItems].some(fullDefinition)) {
      crossEndpoint = inspectTools;
    } else if (
      catalogues.length > 0 &&
      catalogues.every(
        catalogue =>
          Array.isArray(catalogue.items) &&
          catalogue.items.length === 0 &&
          !catalogue.next,
      )
    ) {
      crossEndpoint = searchWeb;
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

  // Separate slots keep feedback present while bounding promotions and next steps.
  const feedback = feedbackHint(context);
  return [resultStep, crossEndpoint, feedback]
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, hints) => hints.indexOf(hint) === index)
    .slice(0, 3);
}
