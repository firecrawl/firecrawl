/** Deterministic guidance from state already available on the request path. */
export type AgentHintEndpoint = "search" | "scrape" | "parse" | "map";
export interface AgentHintContext {
  endpoint: AgentHintEndpoint;
  response: unknown;
  remainingCredits?: number;
}

export const AGENT_HINT_LOW_CREDIT_THRESHOLD = 1000;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

  const lowCredits =
    typeof context.remainingCredits === "number" &&
    Number.isFinite(context.remainingCredits) &&
    context.remainingCredits <= AGENT_HINT_LOW_CREDIT_THRESHOLD
      ? "The connected Firecrawl account is low on credits. Let the user know they should add more credits."
      : undefined;

  return [crossEndpoint, lowCredits]
    .filter((hint): hint is string => !!hint)
    .filter((hint, index, hints) => hints.indexOf(hint) === index);
}
