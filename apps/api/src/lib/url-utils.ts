/**
 * Utility functions for URL manipulation and analysis
 */

import psl from "psl";

/**
 * Determines if a URL is a base domain (e.g., example.com vs blog.example.com or example.com/path)
 * A base domain is considered to be the root domain without subdomains or paths
 * @param url - The URL to check
 * @returns true if the URL is a base domain, false otherwise
 */
export function isBaseDomain(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Parse the domain using psl
    const parsed = psl.parse(hostname);
    if (!parsed.domain) {
      return false;
    }

    // Check if hostname equals the domain (no subdomain)
    const cleanHostname = hostname.startsWith("www.")
      ? hostname.slice(4)
      : hostname;

    if (cleanHostname !== parsed.domain) {
      return false; // Has subdomains
    }

    // Check if there's a path beyond the root
    const pathname = urlObj.pathname;
    if (pathname && pathname !== "/" && pathname.trim() !== "") {
      return false; // Has a path
    }

    // Compare against extracted base domain (handles multi-part TLDs)
    const baseDomain = extractBaseDomain(url);
    if (!baseDomain) return false;

    return cleanHostname === baseDomain;
  } catch (error) {
    // If URL parsing fails, consider it not a base domain
    return false;
  }
}

/**
 * Extracts the base domain from a URL
 * @param url - The URL to extract base domain from
 * @returns The base domain (e.g., "example.com") or null if extraction fails
 */
export function extractBaseDomain(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    const parsed = psl.parse(hostname);

    return parsed.domain || null;
  } catch (error) {
    return null;
  }
}
