import { isIP } from "node:net";

const RUNTIME_PRODUCTS = new Set([
  "apache-httpasyncclient",
  "apache-httpclient",
  "aiohttp",
  "axios",
  "bun",
  "curl",
  "dart",
  "deno",
  "faraday",
  "go-http-client",
  "got",
  "guzzlehttp",
  "java",
  "java-http-client",
  "ktor-client",
  "libcurl-agent",
  "mozilla",
  "node",
  "node-fetch",
  "okhttp",
  "python",
  "python-httpx",
  "python-httpx2",
  "python-requests",
  "python-urllib",
  "reqwest",
  "ruby",
  "undici",
  "wget",
]);

const MAX_SLUG_LENGTH = 48;

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");

function hostSlug(pageUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    host === "localhost" ||
    host === "local" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "firecrawl.dev" ||
    host.endsWith(".firecrawl.dev")
  ) {
    return undefined;
  }
  return slugify(host.replace(/^www\./, "")) || undefined;
}

export function inferIntegration(request: {
  origin?: string;
  referer?: string;
  userAgent?: string;
  bodyOrigin?: unknown;
}): string | undefined {
  const pageUrl = request.origin || request.referer;
  if (pageUrl) {
    const slug = hostSlug(pageUrl);
    return slug ? `_ref.${slug}` : undefined;
  }

  const bodyOrigin =
    typeof request.bodyOrigin === "string"
      ? request.bodyOrigin.trim().toLowerCase()
      : "";
  if (bodyOrigin !== "" && bodyOrigin !== "api") return undefined;

  const product = request.userAgent?.trim().split(/\s+/)[0]?.split("/")[0];
  if (!product || !/^[a-z0-9]/i.test(product)) return undefined;

  const slug = slugify(product);
  if (!slug || slug.startsWith("firecrawl") || RUNTIME_PRODUCTS.has(slug)) {
    return undefined;
  }
  return `_ua.${slug}`;
}
