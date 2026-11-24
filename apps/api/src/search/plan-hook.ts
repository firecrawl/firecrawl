import type { SearchRequest } from "../service/request";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";

export async function applySearchPlanHook<T extends { type: string }>(
  plan: { query: string; limit: number; sources: T[] },
  info: { ctx: RequestContext; body: SearchRequest },
): Promise<{ query: string; limit: number; sources: T[] }> {
  const hooks = installedService()?.hooks;
  if (!hooks?.has("search.plan")) {
    return plan;
  }
  const initialSources = plan.sources.map(source => source.type);
  const planned = await hooks.transform(
    "search.plan",
    {
      query: plan.query,
      limit: plan.limit,
      sources: [...initialSources],
    },
    info,
  );
  const sourcesChanged =
    planned.sources.length !== initialSources.length ||
    planned.sources.some((source, i) => source !== initialSources[i]);
  if (!sourcesChanged) {
    return {
      query: planned.query,
      limit: planned.limit,
      sources: plan.sources,
    };
  }
  const existingByType = new Map(
    plan.sources.map(source => [source.type, source]),
  );
  return {
    query: planned.query,
    limit: planned.limit,
    sources: planned.sources.map(
      type => existingByType.get(type) ?? ({ type } as T),
    ),
  };
}
