// TODO: refactor
import { load } from "cheerio"; // rustified
import { logger } from "../../../lib/logger";
import { extractLinks as _extractLinks, extractBaseHref as _extractBaseHref } from "../../../lib/html-transformer";

function resolveUrlWithBaseHref(href: string, baseUrl: string, baseHref: string): string {
  let resolutionBase = baseUrl;
  
  if (baseHref) {
    try {
      new URL(baseHref);
      resolutionBase = baseHref;
    } catch {
      try {
        resolutionBase = new URL(baseHref, baseUrl).href;
      } catch {
        resolutionBase = baseUrl;
      }
    }
  }
  
  try {
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return href;
    } else if (href.startsWith("mailto:")) {
      return href;
    } else if (href.startsWith("#")) {
      return '';
    } else {
      return new URL(href, resolutionBase).href;
    }
  } catch (error) {
    logger.error(
      `Failed to construct URL for href: ${href} with base: ${resolutionBase}`,
      { error },
    );
    return '';
  }
}

async function extractLinksRust(html: string, baseUrl: string): Promise<string[]> {
  const hrefs = await _extractLinks(html);
  const baseHref = await _extractBaseHref(html, baseUrl);
  const links: string[] = [];

  hrefs.forEach(href => {
    href = href.trim();
    const resolvedUrl = resolveUrlWithBaseHref(href, baseUrl, baseHref);
    if (resolvedUrl) {
      links.push(resolvedUrl);
    }
  });

  return [...new Set(links)];
}

export async function extractLinks(html: string, baseUrl: string): Promise<string[]> {
  try {
    return await extractLinksRust(html, baseUrl);
  } catch (error) {
    logger.warn("Failed to call html-transformer! Falling back to cheerio...", {
      error,
      module: "scrapeURL", method: "extractLinks"
    });
  }

  const $ = load(html);
  const baseHref = $('base[href]').first().attr('href') || '';
  const links: string[] = [];

  $("a").each((_, element) => {
    let href = $(element).attr("href");
    if (href) {
      href = href.trim();
      const resolvedUrl = resolveUrlWithBaseHref(href, baseUrl, baseHref);
      if (resolvedUrl) {
        links.push(resolvedUrl);
      }
    }
  });

  return [...new Set(links)];
}
