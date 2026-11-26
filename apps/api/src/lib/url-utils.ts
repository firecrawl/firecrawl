/**
 * Utility functions for URL manipulation and analysis
 */

import {
  extractBaseDomain as nativeExtractBaseDomain,
  hasReachableHost as nativeHasReachableHost,
  isBaseDomain as nativeIsBaseDomain,
  parseHostname as nativeParseHostname,
  type ParsedHostname,
} from "@mendable/firecrawl-rs";

/**
 * Parses a hostname against the public suffix list (with private domains
 * enabled, so hosting suffixes like vercel.app and github.io resolve per tenant)
 * to find its registrable domain.
 *
 * Route registrable-domain lookups through parseHostname so call sites share
 * consistent suffix rules. Suffix reachability classification uses different
 * rules; see hasReachableHost.
 *
 * @param hostname - The hostname to parse (not a full URL)
 */
export function parseHostname(hostname: string): ParsedHostname {
  return nativeParseHostname(hostname);
}

/**
 * Whether a URL's host is plausibly reachable. Used only for request validation.
 *
 * Accepts IP literals and hosts matching the TLD-shaped pattern (including
 * Cyrillic and punycode labels, as well as private-network suffixes such as
 * .local / .lan / .internal that self-hosted deployments use).
 *
 * @param url - A full URL string
 */
export function hasReachableHost(url: string): boolean {
  return nativeHasReachableHost(url);
}

/**
 * Determines if a URL is a base domain (e.g., example.com vs blog.example.com or example.com/path)
 * A base domain is considered to be the root domain without subdomains or paths
 * @param url - The URL to check
 * @returns true if the URL is a base domain, false otherwise
 */
export function isBaseDomain(url: string): boolean {
  return nativeIsBaseDomain(url);
}

/**
 * Extracts the base domain from a URL
 * @param url - The URL to extract base domain from
 * @returns The base domain (e.g., "example.com") or null if extraction fails
 */
export function extractBaseDomain(url: string): string | null {
  return nativeExtractBaseDomain(url);
}
