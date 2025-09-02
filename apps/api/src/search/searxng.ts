import axios from "axios";
import dotenv from "dotenv";
import { SearchResult } from "../../src/lib/entities";
import { logger } from "../lib/logger";

dotenv.config();

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  num_results: number;
  page?: number;
}

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const params = {
    q: q,
    language: options.lang,
    // gl: options.country, //not possible with SearXNG
    // location: options.location, //not possible with SearXNG
    // num: options.num_results, //not possible with SearXNG
    engines: process.env.SEARXNG_ENGINES || "",
    categories: process.env.SEARXNG_CATEGORIES || "",
    pageno: options.page ?? 1,
    format: "json",
  };

  const url = process.env.SEARXNG_ENDPOINT!;
  // Remove trailing slash if it exists
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;

  // Concatenate "/search" to the cleaned URL
  const finalUrl = cleanedUrl + "/search";

  try {
    const response = await axios.get(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params: params,
    });

    const data = response.data;

    if (data && Array.isArray(data.results)) {
      return data.results.map((a: any) => ({
        url: a.url,
        title: a.title,
        description: a.content,
      }));
    } else {
      return [];
    }
  } catch (error) {
    logger.error(`There was an error searching for content`, { error });
    return [];
  }
}
