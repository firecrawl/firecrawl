import type { GovSearchOptions, GovSearchResponse } from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

const ENDPOINT = "/v2/search/gov";

/** Search the Government Index. */
export async function govSearch(
  http: HttpClient,
  query: string,
  options: GovSearchOptions = {},
): Promise<GovSearchResponse> {
  if (!query || !query.trim()) throw new Error("query cannot be empty");

  try {
    const response = await http.post<GovSearchResponse>(ENDPOINT, {
      query,
      ...(options.k !== undefined ? { k: options.k } : {}),
    });

    if (response.status !== 200 || !response.data?.success) {
      throwForBadResponse(response, "search the Government Index");
    }
    return response.data;
  } catch (error: any) {
    if (error?.isAxiosError) {
      return normalizeAxiosError(error, "search the Government Index");
    }
    throw error;
  }
}
