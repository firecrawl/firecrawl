import { InternalOptions } from "..";
import { ScrapeOptions } from "../../../controllers/v1/types";

export type UrlSpecificParams = {
  scrapeOptions: Partial<ScrapeOptions>;
  internalOptions: Partial<InternalOptions>;
};

// const docsParam: UrlSpecificParams = {
//     scrapeOptions: { waitFor: 2000 },
//     internalOptions: {},
// }

export const urlSpecificParams: Record<string, UrlSpecificParams> = {
  // "support.greenpay.me": docsParam,
  // "docs.pdw.co": docsParam,
  // "developers.notion.com": docsParam,
  // "docs2.hubitat.com": docsParam,
  // "rsseau.fr": docsParam,
  // "help.salesforce.com": docsParam,
  // "scrapethissite.com": {
  //     scrapeOptions: {},
  //     internalOptions: { forceEngine: "fetch" },
  // },
  // "eonhealth.com": {
  //     defaultScraper: "fire-engine",
  //     params: {
  //         fireEngineOptions: {
  //             mobileProxy: true,
  //             method: "get",
  //             engine: "request",
  //         },
  //     },
  // },
  // "notion.com": {
  //     scrapeOptions: { waitFor: 2000 },
  //     internalOptions: { forceEngine: "fire-engine;playwright" }
  // },
  // "developer.apple.com": {
  //     scrapeOptions: { waitFor: 2000 },
  //     internalOptions: { forceEngine: "fire-engine;playwright" }
  // },
  
  // WeChat MP domain requires special handling to avoid robot protection
  "mp.weixin.qq.com": {
    scrapeOptions: {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1"
      },
      waitFor: 3000,
      proxy: "stealth" as const
    },
    internalOptions: { 
      forceEngine: "fire-engine;chrome-cdp;stealth" as const
    },
  },
  "digikey.com": {
    scrapeOptions: {},
    internalOptions: { forceEngine: "fire-engine;tlsclient" },
  },
  "lorealparis.hu": {
    scrapeOptions: {},
    internalOptions: { forceEngine: "fire-engine;tlsclient" },
  },
};
