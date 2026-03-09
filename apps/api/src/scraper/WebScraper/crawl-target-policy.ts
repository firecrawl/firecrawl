import { extractBaseDomain } from "../../lib/url-utils";

function normalizeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function shouldDenyCrawlTarget({
  initialUrl,
  targetUrl,
  allowExternalContentLinks,
  allowSubdomains,
}: {
  initialUrl: string;
  targetUrl: string;
  allowExternalContentLinks: boolean;
  allowSubdomains: boolean;
}): "EXTERNAL_LINK" | null {
  if (allowExternalContentLinks) {
    return null;
  }

  const initialHostname = normalizeHostname(initialUrl);
  const targetHostname = normalizeHostname(targetUrl);
  if (!initialHostname || !targetHostname) {
    return null;
  }

  if (!allowSubdomains) {
    return initialHostname === targetHostname ? null : "EXTERNAL_LINK";
  }

  const initialBaseDomain = extractBaseDomain(initialUrl) ?? initialHostname;
  const targetBaseDomain = extractBaseDomain(targetUrl) ?? targetHostname;
  return initialBaseDomain === targetBaseDomain ? null : "EXTERNAL_LINK";
}
