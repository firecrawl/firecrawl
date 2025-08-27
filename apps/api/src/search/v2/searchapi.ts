import axios from "axios";
import dotenv from "dotenv";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";

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

export async function searchapi_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const params = {
    q: q,
    hl: options.lang,
    gl: options.country,
    location: options.location,
    num: options.num_results,
    page: options.page ?? 1,
    engine: process.env.SEARCHAPI_ENGINE || "google",
  };

  const url = `https://www.searchapi.io/api/v1/search`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.SEARCHAPI_API_KEY}`,
        "Content-Type": "application/json",
        "X-SearchApi-Source": "Firecrawl",
      },
      params: params,
    });

    if (response.status === 401) {
      throw new Error("Unauthorized. Please check your API key.");
    }

    const data = response.data;

    if (data && Array.isArray(data.organic_results)) {
      const webResults: WebSearchResult[] = data.organic_results.map((a: any) => ({
        url: a.link,
        title: a.title,
        description: a.snippet,
      }));
      
      return {
        web: webResults
      };
    } else {
      return {};
    }
  } catch (error) {
    console.error(`There was an error searching for content: ${error.message}`);
    return {};
  }
}