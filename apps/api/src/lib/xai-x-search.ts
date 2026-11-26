import { z } from "zod";
import { logger } from "./logger";

// xAI bills X Search per item fetched, on top of tokens
// (https://docs.x.ai/developers/pricing). USD per item.
const X_SEARCH_USD_PER_POST = 5 / 1000;
const X_SEARCH_USD_PER_PROFILE = 10 / 1000;

type XSearchUsage = { posts: number; profiles: number };

const rawToolUsageResponseSchema = z.object({
  usage: z.object({
    server_side_tool_usage_details: z.object({
      x_posts_fetched: z.unknown().optional(),
      x_users_fetched: z.unknown().optional(),
    }),
  }),
});

// A missing field means nothing of that kind was fetched. A field that is
// present but not a count means the provider changed shape, and reading it as
// 0 would silently drop that fee.
const itemCountSchema = z
  .number()
  .finite()
  .nonnegative()
  .transform(value => Math.trunc(value))
  .nullish()
  .transform(value => value ?? 0);

const parsedToolUsageCountsSchema = z.object({
  x_posts_fetched: itemCountSchema,
  x_users_fetched: itemCountSchema,
});

// The Responses API reports fetched items under
// `usage.server_side_tool_usage_details`. `@ai-sdk/xai` drops that block when
// it parses usage, so read it from the raw response body.
export function xSearchUsageFromResponseBody(
  body: unknown,
): XSearchUsage | undefined {
  const raw = rawToolUsageResponseSchema.safeParse(body);
  if (!raw.success) {
    return undefined;
  }
  const details = raw.data.usage.server_side_tool_usage_details;
  if (
    details.x_posts_fetched === undefined &&
    details.x_users_fetched === undefined
  ) {
    return undefined;
  }
  const counts = parsedToolUsageCountsSchema.safeParse(details);
  if (!counts.success) {
    logger.warn("Unreadable X Search item counts in xAI usage", {
      module: "xai-x-search",
      x_posts_fetched: details.x_posts_fetched,
      x_users_fetched: details.x_users_fetched,
    });
    return undefined;
  }
  return {
    posts: counts.data.x_posts_fetched,
    profiles: counts.data.x_users_fetched,
  };
}

export function xSearchCost(usage: XSearchUsage): number {
  return (
    usage.posts * X_SEARCH_USD_PER_POST +
    usage.profiles * X_SEARCH_USD_PER_PROFILE
  );
}
