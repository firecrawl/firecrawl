import axios from "axios";
import { JSDOM } from 'jsdom';
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";
import https from 'https';

const getRandomInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

export function get_useragent(): string {
    const lynx_version = `Lynx/${getRandomInt(2, 3)}.${getRandomInt(8, 9)}.${getRandomInt(0, 2)}`;
    const libwww_version = `libwww-FM/${getRandomInt(2, 3)}.${getRandomInt(13, 15)}`;
    const ssl_mm_version = `SSL-MM/${getRandomInt(1, 2)}.${getRandomInt(3, 5)}`;
    const openssl_version = `OpenSSL/${getRandomInt(1, 3)}.${getRandomInt(0, 4)}.${getRandomInt(0, 9)}`;
    return `${lynx_version} ${libwww_version} ${ssl_mm_version} ${openssl_version}`;
}

async function _req(
  term: string,
  results: number,
  lang: string,
  country: string,
  start: number,
  proxies: any,
  timeout: number,
  tbs: string | undefined = undefined,
  filter: string | undefined = undefined,
) {
  const params = {
    q: term,
    num: results+2, // Number of results to return
    hl: lang,
    gl: country,
    safe: "active",
    start: start,
  };
  if (tbs) {
    params["tbs"] = tbs;
  }
  if (filter) {
    params["filter"] = filter;
  }
  var agent = get_useragent();
  try {
    const resp = await axios.get("https://www.google.com/search", {
      headers: {
        "User-Agent": agent,
          "Accept": "*/*"
      },
      params: params,
      proxy: proxies,
      timeout: timeout,
      httpsAgent: new https.Agent({
        rejectUnauthorized: true 
      }),
      withCredentials: true
    });
    return resp;
  } catch (error) {
    if (error.response && error.response.status === 429) {
      logger.warn("Google Search: Too many requests, try again later.", {
          status: error.response.status,
          statusText: error.response.statusText
      });
      throw new Error("Google Search: Too many requests, try again later.");
    }
    throw error;
  }
}

export async function googleSearch(
  term: string,
  advanced = false,
  num_results = 5,
  tbs = undefined as string | undefined,
  filter = undefined as string | undefined,
  lang = "en",
  country = "us",
  proxy = undefined as string | undefined,
  sleep_interval = 0,
  timeout = 5000,
): Promise<SearchV2Response> {
  let proxies: any = null;
  if (proxy) {
    if (proxy.startsWith("https")) {
      proxies = { https: proxy };
    } else {
      proxies = { http: proxy };
    }
  }

  // TODO: knowledge graph, answer box, etc.

  let start = 0;
  let results: WebSearchResult[] = [];
  let attempts = 0;
  const maxAttempts = 20; // Define a maximum number of attempts to prevent infinite loop
  while (start < num_results && attempts < maxAttempts) {
    try {
      const resp = await _req(
        term,
        num_results - start,
        lang,
        country,
        start,
        proxies,
        timeout,
        tbs,
        filter,
      );
      const dom = new JSDOM(resp.data);
      const document = dom.window.document;
      const result_block = document.querySelectorAll("div.ezO2md");
      let new_results = 0;
      let unique = true;
      let fetched_results = 0;

      const fetched_links = new Set<string>();
      if (result_block.length === 0) {
        start += 1;
        attempts += 1;
      } else {
        attempts = 0;
      }

      for (const result of result_block) {
          const link_tag = result.querySelector("a[href]") as HTMLAnchorElement;
          const title_tag = link_tag ? link_tag.querySelector("span.CVA68e") : null;
          const description_tag = result.querySelector("span.FrIlee");

          if (link_tag && title_tag && description_tag) {
              const link = decodeURIComponent(link_tag.href.split("&")[0].replace("/url?q=", ""));
              if (fetched_links.has(link) && unique) continue;
              fetched_links.add(link);
              const title = title_tag.textContent || "";
              const description = description_tag.textContent || "";
              fetched_results++;
              new_results++;
              if (link && title && description) {
                start += 1
                results.push({
                  url: link,
                  title: title,
                  description: description
                });
              }
              if (fetched_results >= num_results) break;
          }
      }

      await new Promise((resolve) =>
        setTimeout(resolve, sleep_interval * 1000),
      );
    } catch (error) {
      if (error.message === "Too many requests") {
        logger.warn("Too many requests, breaking the loop");
        break;
      }
      throw error;
    }

    if (start === 0) {
      return results.length > 0 ? { web: results } : {};
    }
  }
  if (attempts >= maxAttempts) {
    logger.warn("Max attempts reached, breaking the loop");
  }
  return results.length > 0 ? { web: results } : {};
}