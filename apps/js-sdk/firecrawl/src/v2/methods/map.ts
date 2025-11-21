import { type MapData, type MapOptions, type SearchResultWeb } from "../types";
import { HttpClient } from "../utils/httpClient";
import { throwForBadResponse, normalizeAxiosError } from "../utils/errorHandler";

function prepareMapPayload(url: string, options?: MapOptions): Record<string, unknown> {
  if (!url || !url.trim()) throw new Error("URL cannot be empty");
  const payload: Record<string, unknown> = { url: url.trim() };
  if (options) {
    if (options.sitemap != null) payload.sitemap = options.sitemap;
    if (options.search != null) payload.search = options.search;
    if (options.includeSubdomains != null) payload.includeSubdomains = options.includeSubdomains;
    if (options.ignoreQueryParameters != null) payload.ignoreQueryParameters = options.ignoreQueryParameters;
    if (options.limit != null) payload.limit = options.limit;
    if (options.timeout != null) payload.timeout = options.timeout;
    if (options.integration != null && options.integration.trim()) payload.integration = options.integration.trim();
    if (options.location != null) payload.location = options.location;
  }
  return payload;
}

export async function map(http: HttpClient, url: string, options?: MapOptions): Promise<MapData> {
  const payload = prepareMapPayload(url, options);
  try {
    const res = await http.post<{ success: boolean; error?: string; links?: Array<string | SearchResultWeb> }>("/v2/map", payload);
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "map");
    }
    const linksIn = res.data.links || [];
    const links: SearchResultWeb[] = [];
    for (const item of linksIn) {
      if (typeof item === "string") links.push({ url: item });
      else if (item && typeof item === "object") links.push({ url: item.url, title: (item as any).title, description: (item as any).description });
    }
    return { links };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "map");
    throw err;
  }
}

