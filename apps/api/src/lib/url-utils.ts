/**
 * Utility functions for URL manipulation and analysis
 */

import { parse as parseTld } from "tldts";

/**
 * Options for resolving a REGISTRABLE DOMAIN.
 *
 * allowPrivateDomains is required: tldts defaults it off, which treats hosting
 * suffixes (vercel.app, github.io, pages.dev) as ordinary TLDs and reports
 * hello.vercel.app's registrable domain as "vercel.app" — someone else's site.
 * It is also what the tldts docs prescribe for matching psl, which this replaced.
 *
 * extractHostname is off because callers pass a bare hostname, not a URL.
 *
 * Route registrable-domain lookups through parseHostname rather than importing
 * tldts directly, so no call site can forget these. Note that suffix
 * CLASSIFICATION is a different question and wants different options — see
 * hasReachableHost.
 */
const REGISTRABLE_DOMAIN_OPTIONS = {
  allowPrivateDomains: true,
  extractHostname: false,
} as const;

/**
 * Parses a hostname against the public suffix list to find its registrable domain.
 * @param hostname - The hostname to parse (not a full URL)
 */
export function parseHostname(
  hostname: string,
): ReturnType<typeof parseTld> {
  return parseTld(hostname, REGISTRABLE_DOMAIN_OPTIONS);
}

/**
 * The historic "looks like it has a TLD" test: a final label of 2+ alphanumerics
 * (incl. the Cyrillic ranges) or an xn-- punycode label, optionally with a port.
 */
const LOOKS_LIKE_TLD =
  /(\.[a-zA-Z0-9-Ѐ-ӿԀ-ԯⷠ-ⷿꙀ-ꚟ]{2,}|\.xn--[a-zA-Z0-9-]{1,})(:\d+)?([\/?#]|$)/i;

/**
 * Whether a URL's host is plausibly reachable. Used only for request validation.
 *
 * Accepts IP literals. The previous regex rejected these only when the final octet
 * was a single digit, so 93.184.216.34 was allowed while 8.8.8.8 was not — an
 * accident of `[a-zA-Z0-9]{2,}` matching digits, not a policy. Which addresses are
 * actually reachable is enforced downstream (safeFetch's connect-time check, and
 * the scraping proxy), not here.
 *
 * Everything else falls through to the historic pattern. Requiring a known public
 * suffix instead would reject .local / .lan / .internal hosts that self-hosted
 * deployments legitimately use, and any TLD delegated after the pinned tldts
 * release; the public suffix list deliberately contains no private-network TLDs,
 * so there is no maintained list to check them against. The cost of keeping the
 * pattern is that a typo'd TLD such as example.invalidtld still passes, exactly as
 * it did before.
 *
 * @param url - A full URL string; tldts extracts the host itself.
 */
export function hasReachableHost(url: string): boolean {
  if (parseTld(url).isIp === true) return true;
  return LOOKS_LIKE_TLD.test(url);
}

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

    const parsed = parseHostname(hostname);
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

    const parsed = parseHostname(hostname);

    return parsed.domain || null;
  } catch (error) {
    return null;
  }
}
