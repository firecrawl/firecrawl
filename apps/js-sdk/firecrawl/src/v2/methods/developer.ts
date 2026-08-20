import type { DeveloperSearchOptions, DeveloperSearchResponse } from "../types";
import { HttpClient } from "../utils/httpClient";
import { throwForBadResponse } from "../utils/errorHandler";

const ENDPOINT = "/v2/search/developer";

/** Search the dedicated developer index with its complete filter surface. */
export async function developerSearch(
  http: HttpClient,
  query: string,
  options: DeveloperSearchOptions = {},
): Promise<DeveloperSearchResponse> {
  if (!query || !query.trim()) throw new Error("query cannot be empty");

  const response = await http.post<DeveloperSearchResponse>(ENDPOINT, {
    query,
    ...(options.k !== undefined ? { k: options.k } : {}),
    ...(options.passages !== undefined ? { passages: options.passages } : {}),
    ...(options.types !== undefined ? { types: options.types } : {}),
    ...(options.repos !== undefined ? { repos: options.repos } : {}),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.topic !== undefined ? { topic: options.topic } : {}),
    ...(options.license !== undefined ? { license: options.license } : {}),
    ...(options.minStars !== undefined ? { min_stars: options.minStars } : {}),
    ...(options.maxStars !== undefined ? { max_stars: options.maxStars } : {}),
    ...(options.archived !== undefined ? { archived: options.archived } : {}),
    ...(options.fork !== undefined ? { fork: options.fork } : {}),
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
  });

  if (response.status !== 200) {
    throwForBadResponse(response, "search developer sources");
  }
  return response.data;
}
