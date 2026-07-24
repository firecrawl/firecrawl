import { InternalOptions } from "..";
import { ScrapeOptions } from "../../../controllers/v1/types";

type UrlSpecificParams = {
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
  "raw.githubusercontent.com": {
    scrapeOptions: {},
    internalOptions: { forceEngine: "fetch" },
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
