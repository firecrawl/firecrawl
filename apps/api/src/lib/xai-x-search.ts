import { logger } from "./logger";

// xAI bills X Search per item fetched, on top of tokens
// (https://docs.x.ai/developers/pricing). USD per item.
const X_SEARCH_USD_PER_POST = 5 / 1000;
const X_SEARCH_USD_PER_PROFILE = 10 / 1000;

type XSearchUsage = { posts: number; profiles: number };

const INVALID = Symbol("invalid");

// A missing field means nothing of that kind was fetched. A field that is
// present but not a count means the provider changed shape, and reading it as
// 0 would silently drop that fee.
function count(value: unknown): number | typeof INVALID {
  if (value === undefined || value === null) {
    return 0;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : INVALID;
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
  if (!("x_posts_fetched" in details) && !("x_users_fetched" in details)) {
    return undefined;
  }
  const posts = count(details.x_posts_fetched);
  const profiles = count(details.x_users_fetched);
  if (posts === INVALID || profiles === INVALID) {
    logger.warn("Unreadable X Search item counts in xAI usage", {
      module: "xai-x-search",
      x_posts_fetched: details.x_posts_fetched,
      x_users_fetched: details.x_users_fetched,
    });
    return undefined;
  }
  return { posts, profiles };
}

export function xSearchCost(usage: XSearchUsage): number {
  return (
    usage.posts * X_SEARCH_USD_PER_POST +
    usage.profiles * X_SEARCH_USD_PER_PROFILE
  );
}
