import { load } from "cheerio";
import { logger } from "../../../lib/logger";
import { extractImages as _extractImages } from "@mendable/firecrawl-rs";

function resolveImageUrl(
  src: string,
  baseUrl: string,
  baseHref: string = "",
): string {
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
    // Skip data URIs and blob URLs
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      return src;
    }

    // Handle absolute URLs
    if (src.startsWith("http://") || src.startsWith("https://")) {
      return src;
    }

    // Handle protocol-relative URLs
    if (src.startsWith("//")) {
      const protocol = new URL(baseUrl).protocol;
      return protocol + src;
    }

    // Handle relative URLs
    return new URL(src, resolutionBase).href;
  } catch (error) {
    logger.debug("Failed to resolve image URL", {
      src,
      baseUrl,
      error,
      module: "scrapeURL",
      method: "extractImages",
    });
    return "";
  }
}

async function extractImagesCheerio(
  html: string,
  baseUrl: string,
): Promise<string[]> {
  const $ = load(html);
  const baseHref = $("base[href]").first().attr("href") || "";
  const images: Set<string> = new Set();

  // Extract from <img> tags
  $("img").each((_, element) => {
    const src = $(element).attr("src");
    if (src) {
      const resolvedUrl = resolveImageUrl(src.trim(), baseUrl, baseHref);
      if (resolvedUrl) {
        images.add(resolvedUrl);
      }
    }

    // Also check data-src for lazy-loaded images
    const dataSrc = $(element).attr("data-src");
    if (dataSrc) {
      const resolvedUrl = resolveImageUrl(dataSrc.trim(), baseUrl, baseHref);
      if (resolvedUrl) {
        images.add(resolvedUrl);
      }
    }

    // Check srcset for responsive images
    const srcset = $(element).attr("srcset");
    if (srcset) {
      // Parse srcset: "url1 1x, url2 2x, ..."
      const urls = srcset.split(",").map(s => s.trim().split(/\s+/)[0]);
      urls.forEach(url => {
        if (url) {
          const resolvedUrl = resolveImageUrl(url, baseUrl, baseHref);
          if (resolvedUrl) {
            images.add(resolvedUrl);
          }
        }
      });
    }
  });

  // Extract from <picture> elements
  $("picture source").each((_, element) => {
    const srcset = $(element).attr("srcset");
    if (srcset) {
      const urls = srcset.split(",").map(s => s.trim().split(/\s+/)[0]);
      urls.forEach(url => {
        if (url) {
          const resolvedUrl = resolveImageUrl(url, baseUrl, baseHref);
          if (resolvedUrl) {
            images.add(resolvedUrl);
          }
        }
      });
    }
  });

  // Extract from meta tags (Open Graph, Twitter Cards)
  const metaImages = [
    $('meta[property="og:image"]').attr("content"),
    $('meta[property="og:image:url"]').attr("content"),
    $('meta[property="og:image:secure_url"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    $('meta[name="twitter:image:src"]').attr("content"),
    $('meta[itemprop="image"]').attr("content"),
  ];

  metaImages.forEach(src => {
    if (src) {
      const resolvedUrl = resolveImageUrl(src.trim(), baseUrl, baseHref);
      if (resolvedUrl) {
        images.add(resolvedUrl);
      }
    }
  });

  // Extract from link tags (apple-touch-icon, etc.)
  $(
    'link[rel*="icon"], link[rel*="apple-touch-icon"], link[rel*="image_src"]',
  ).each((_, element) => {
    const href = $(element).attr("href");
    if (href) {
      const resolvedUrl = resolveImageUrl(href.trim(), baseUrl, baseHref);
      if (resolvedUrl) {
        images.add(resolvedUrl);
      }
    }
  });

  // Extract background images from inline styles
  $("[style*='background-image']").each((_, element) => {
    const style = $(element).attr("style") || "";
    const matches = style.match(
      /background-image:\s*url\(['"]?([^'")]+)['"]?\)/gi,
    );
    if (matches) {
      matches.forEach(match => {
        const urlMatch = match.match(/url\(['"]?([^'")]+)['"]?\)/i);
        if (urlMatch && urlMatch[1]) {
          const resolvedUrl = resolveImageUrl(
            urlMatch[1].trim(),
            baseUrl,
            baseHref,
          );
          if (resolvedUrl) {
            images.add(resolvedUrl);
          }
        }
      });
    }
  });

  // Extract from video poster attributes
  $("video[poster]").each((_, element) => {
    const poster = $(element).attr("poster");
    if (poster) {
      const resolvedUrl = resolveImageUrl(poster.trim(), baseUrl, baseHref);
      if (resolvedUrl) {
        images.add(resolvedUrl);
      }
    }
  });

  // Filter out invalid URLs and convert Set to Array
  return Array.from(images).filter(url => {
    try {
      // Skip javascript: URLs for security
      if (url.toLowerCase().startsWith("javascript:")) {
        return false;
      }
      new URL(url);
      return true;
    } catch {
      return false;
    }
  });
}

export async function extractImages(
  html: string,
  baseUrl: string,
): Promise<string[]> {
  try {
    return await _extractImages(html, baseUrl);
  } catch (error) {
    logger.warn("Failed to call html-transformer! Falling back to cheerio...", {
      error,
      module: "scrapeURL",
      method: "extractImages",
    });

    // Fallback to Cheerio implementation
    return await extractImagesCheerio(html, baseUrl);
  }
}
