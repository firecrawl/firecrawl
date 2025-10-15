/**
 * Utility functions for URL handling and modification
 */

/**
 * Modifies a crawl URL by stripping the /* suffix if present
 * @param url - The URL to potentially modify
 * @returns Object containing the modified URL, modification flag, and original URL
 */
export function modifyCrawlUrl(url: string): {
  url: string;
  wasModified: boolean;
  originalUrl: string;
} {
  if (url.endsWith("/*")) {
    return {
      url: url.slice(0, -2),
      wasModified: true,
      originalUrl: url,
    };
  }
  return {
    url: url,
    wasModified: false,
    originalUrl: url,
  };
}
