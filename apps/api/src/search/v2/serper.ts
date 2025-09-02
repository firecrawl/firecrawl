import axios from "axios";
import dotenv from "dotenv";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";

dotenv.config();

export async function serper_search(
  q,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    num_results: number;
    page?: number;
  },
): Promise<SearchV2Response> {
  let data = JSON.stringify({
    q: q,
    hl: options.lang,
    gl: options.country,
    location: options.location,
    tbs: options.tbs,
    num: options.num_results,
    page: options.page ?? 1,
  });

  let config = {
    method: "POST",
    url: "https://google.serper.dev/search",
    headers: {
      "X-API-KEY": process.env.SERPER_API_KEY,
      "Content-Type": "application/json",
    },
    data: data,
  };

  try {
    const response = await axios(config);
    if (response && response.data && Array.isArray(response.data.organic)) {
      const webResults: WebSearchResult[] = response.data.organic.map(a => ({
        url: a.link,
        title: a.title,
        description: a.snippet,
      }));

      return {
        web: webResults,
      };
    } else {
      return {};
    }
  } catch (error) {
    return {};
  }
}
