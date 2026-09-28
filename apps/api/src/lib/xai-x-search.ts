// xAI bills X Search per item fetched, on top of tokens
// (https://docs.x.ai/developers/pricing). USD per item.
const X_SEARCH_USD_PER_POST = 5 / 1000;
const X_SEARCH_USD_PER_PROFILE = 10 / 1000;

type XSearchUsage = { posts: number; profiles: number };

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

// The Responses API reports fetched items under
// `usage.server_side_tool_usage_details`. `@ai-sdk/xai` drops that block when
// it parses usage, so read it from the raw response body.
export function xSearchUsageFromResponseBody(
  body: unknown,
): XSearchUsage | undefined {
  const details = (body as any)?.usage?.server_side_tool_usage_details;
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const posts = count(details.x_posts_fetched);
  const profiles = count(details.x_users_fetched);
  if (posts === undefined && profiles === undefined) {
    return undefined;
  }
  return { posts: posts ?? 0, profiles: profiles ?? 0 };
}

export function xSearchCost(usage: XSearchUsage): number {
  return (
    usage.posts * X_SEARCH_USD_PER_POST +
    usage.profiles * X_SEARCH_USD_PER_PROFILE
  );
}
