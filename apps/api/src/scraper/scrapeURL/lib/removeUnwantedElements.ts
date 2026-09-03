// TODO: refactor

import { AnyNode, Cheerio, load } from "cheerio"; // rustified
import { ScrapeOptions } from "../../../controllers/v2/types";
import { transformHtml } from "@mendable/firecrawl-rs";
import { logger } from "../../../lib/logger";
import { queryOMCESignatures } from "../../../services/index";

const excludeNonMainTags = [
  "header",
  "footer",
  "nav",
  "aside",
  ".header",
  ".top",
  ".navbar",
  "#header",
  ".footer",
  ".bottom",
  "#footer",
  ".sidebar",
  ".side",
  ".aside",
  "#sidebar",
  ".modal",
  ".popup",
  "#modal",
  ".overlay",
  ".ad",
  ".ads",
  ".advert",
  "#ad",
  ".lang-selector",
  ".language",
  "#language-selector",
  ".social",
  ".social-media",
  ".social-links",
  "#social",
  ".menu",
  ".navigation",
  "#nav",
  ".breadcrumbs",
  "#breadcrumbs",
  ".share",
  "#share",
  ".widget",
  "#widget",
  ".cookie",
  "#cookie",
];

const forceIncludeMainTags = [
  "#main",
  ".swoogo-cols",
  ".swoogo-text",
  ".swoogo-table-div",
  ".swoogo-space",
  ".swoogo-alert",
  ".swoogo-sponsors",
  ".swoogo-title",
  ".swoogo-tabs",
  ".swoogo-logo",
  ".swoogo-image",
  ".swoogo-button",
  ".swoogo-agenda",
];

const ATTRIBUTION_TEXT_PATTERN =
  /©|\u00A9|\(c\)\s*\d{4}|Copyright\s+(\(c\)|\d{4})|All\s+Rights\s+Reserved|Creative\s+Commons|creativecommons\.org|CC[\s-]BY([\s-](SA|NC|ND|NC[\s-]SA|NC[\s-]ND))?|CC0|Licensed\s+under|Photo\s+by|Photo\s+credit|Image\s+credit/i;

const ATTRIBUTION_SELECTOR = [
  'a[rel="license"]',
  'a[href*="creativecommons.org"]',
  '[itemprop="copyrightHolder"]',
  '[itemprop="copyrightYear"]',
  '[itemprop="author"]',
  '[itemprop="creator"]',
  '[class*="copyright"]',
  '[class*="license"]',
].join(",");

function containsAttribution(
  soup: ReturnType<typeof load>,
  el: AnyNode,
): boolean {
  const $el = soup(el);
  const text = $el.text();
  if (ATTRIBUTION_TEXT_PATTERN.test(text)) {
    return true;
  }
  if ($el.find(ATTRIBUTION_SELECTOR).length > 0) {
    return true;
  }
  if ($el.is(ATTRIBUTION_SELECTOR)) {
    return true;
  }
  return false;
}

function stripNonAttributionChildren(
  soup: ReturnType<typeof load>,
  el: AnyNode,
): void {
  soup(el)
    .children()
    .each((_, child) => {
      if (child.type === "tag") {
        if (containsAttribution(soup, child)) {
          stripNonAttributionChildren(soup, child);
        } else {
          soup(child).remove();
        }
      }
      // text nodes, comments, etc. are kept as-is
    });
}

export const htmlTransform = async (
  html: string,
  url: string,
  scrapeOptions: ScrapeOptions,
) => {
  let omceSignatures: string[] | undefined = undefined;

  if (scrapeOptions.__experimental_omce) {
    try {
      const hostname =
        scrapeOptions.__experimental_omceDomain || new URL(url).hostname;
      omceSignatures = await queryOMCESignatures(hostname);
      logger.info("Got OMCE signatures", { signatures: omceSignatures.length });
    } catch (error) {
      logger.warn("Failed to get omce signatures.", {
        error,
        scrapeURL: url,
        module: "scrapeURL",
        method: "htmlTransform",
      });
    }
  }

  try {
    return await transformHtml({
      html,
      url,
      includeTags: (scrapeOptions.includeTags ?? [])
        .map(x => x.trim())
        .filter(x => x.length !== 0),
      excludeTags: (scrapeOptions.excludeTags ?? [])
        .map(x => x.trim())
        .filter(x => x.length !== 0),
      onlyMainContent: scrapeOptions.onlyMainContent,
      omceSignatures,
    });
  } catch (error) {
    logger.warn("Failed to call html-transformer! Falling back to cheerio...", {
      error,
      module: "scrapeURL",
      method: "htmlTransform",
    });
  }

  let soup = load(html);

  // remove unwanted elements
  if (
    scrapeOptions.includeTags &&
    scrapeOptions.includeTags.filter(x => x.trim().length !== 0).length > 0
  ) {
    // Create a new root element to hold the tags to keep
    const newRoot = load("<div></div>")("div");
    scrapeOptions.includeTags.forEach(tag => {
      soup(tag).each((_, element) => {
        newRoot.append(soup(element).clone());
      });
    });

    soup = load(newRoot.html() ?? "");
  }

  soup("script, style, noscript, meta, head").remove();

  if (
    scrapeOptions.excludeTags &&
    scrapeOptions.excludeTags.filter(x => x.trim().length !== 0).length > 0
  ) {
    scrapeOptions.excludeTags.forEach(tag => {
      let elementsToRemove: Cheerio<AnyNode>;
      if (tag.startsWith("*") && tag.endsWith("*")) {
        let classMatch = false;

        const regexPattern = new RegExp(tag.slice(1, -1), "i");
        elementsToRemove = soup("*").filter((i, element) => {
          if (element.type === "tag") {
            const attributes = element.attribs;
            const tagNameMatches = regexPattern.test(element.name);
            const attributesMatch = Object.keys(attributes).some(attr =>
              regexPattern.test(`${attr}="${attributes[attr]}"`),
            );
            if (tag.startsWith("*.")) {
              classMatch = Object.keys(attributes).some(attr =>
                regexPattern.test(`class="${attributes[attr]}"`),
              );
            }
            return tagNameMatches || attributesMatch || classMatch;
          }
          return false;
        });
      } else {
        elementsToRemove = soup(tag);
      }
      elementsToRemove.remove();
    });
  }

  if (scrapeOptions.onlyMainContent) {
    excludeNonMainTags.forEach(tag => {
      const candidates = soup(tag).filter(
        forceIncludeMainTags.map(x => ":not(:has(" + x + "))").join(""),
      );
      candidates.each((_, el) => {
        if (containsAttribution(soup, el)) {
          stripNonAttributionChildren(soup, el);
        } else {
          soup(el).remove();
        }
      });
    });
  }

  // always return biggest image
  soup("img[srcset]").each((_, el) => {
    const sizes = el.attribs.srcset.split(",").map(x => {
      const tok = x.trim().split(" ");
      return {
        url: tok[0],
        size: parseInt((tok[1] ?? "1x").slice(0, -1), 10),
        isX: (tok[1] ?? "").endsWith("x"),
      };
    });

    if (sizes.every(x => x.isX) && el.attribs.src) {
      sizes.push({
        url: el.attribs.src,
        size: 1,
        isX: true,
      });
    }

    sizes.sort((a, b) => b.size - a.size);

    el.attribs.src = sizes[0]?.url;
  });

  // absolute links
  soup("img[src]").each((_, el) => {
    try {
      el.attribs.src = new URL(el.attribs.src, url).href;
    } catch (_) {}
  });
  soup("a[href]").each((_, el) => {
    try {
      el.attribs.href = new URL(el.attribs.href, url).href;
    } catch (_) {}
  });

  const cleanedHtml = soup.html();
  return cleanedHtml;
};
