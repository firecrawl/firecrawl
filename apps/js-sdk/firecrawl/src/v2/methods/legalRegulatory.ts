import type {
  LegalRegulatorySearchOptions,
  LegalRegulatorySearchResponse,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

const ENDPOINT = "/v2/search/gov";

/** Search the Legal and Regulatory Index. */
export async function legalRegulatorySearch(
  http: HttpClient,
  query: string,
  options: LegalRegulatorySearchOptions = {},
): Promise<LegalRegulatorySearchResponse> {
  if (!query || !query.trim()) throw new Error("query cannot be empty");

  try {
    const response = await http.post<LegalRegulatorySearchResponse>(ENDPOINT, {
      query,
      ...(options.k !== undefined ? { k: options.k } : {}),
    });

    if (response.status !== 200 || !response.data?.success) {
      throwForBadResponse(response, "search legal and regulatory sources");
    }
    return response.data;
  } catch (error: any) {
    if (error?.isAxiosError) {
      return normalizeAxiosError(error, "search legal and regulatory sources");
    }
    throw error;
  }
}
