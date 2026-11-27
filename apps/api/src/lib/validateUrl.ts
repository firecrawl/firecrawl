import { fetch as undiciFetch } from "undici";
import { getSecureDispatcher } from "../scraper/scrapeURL/engines/utils/safeFetch";
import { loadMock } from "../scraper/scrapeURL/lib/mock";

export const protocolIncluded = (url: string) => {
  // if :// not in the start of the url assume http (maybe https?)
  // regex checks if :// appears before any .
  return /^([^.:]+:\/\/)/i.test(url);
};

const cleanHostname = (hostname: string) => {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
};

const getURLobj = (
  s: string,
): { error: false; urlObj: URL } | { error: true; urlObj: null } => {
  // URL fails if we dont include the protocol ie google.com
  try {
    return { error: false, urlObj: new URL(s) };
  } catch {
    return { error: true, urlObj: null };
  }
};

export const checkAndUpdateURL = (url: string) => {
  if (!protocolIncluded(url)) {
    url = `http://${url}`;
  }

  const parsed = getURLobj(url);
  if (parsed.error) {
    throw new Error("Invalid URL");
  }

  const typedUrlObj = parsed.urlObj;

  if (typedUrlObj.protocol !== "http:" && typedUrlObj.protocol !== "https:") {
    throw new Error("Invalid URL");
  }

  return { urlObj: typedUrlObj, url };
};

export const checkUrl = (url: string) => {
  const parsed = getURLobj(url);
  if (parsed.error) {
    throw new Error("Invalid URL");
  }

  const typedUrlObj = parsed.urlObj;

  if (typedUrlObj.protocol !== "http:" && typedUrlObj.protocol !== "https:") {
    throw new Error("Invalid URL");
  }

  if ((url.split(".")[0].match(/:/g) || []).length !== 1) {
    throw new Error("Invalid URL. Invalid protocol."); // for this one: http://http://example.com
  }

  return url;
};

/**
 * Same domain check
 * It checks if the domain of the url is the same as the base url
 * It accounts true for subdomains and www.subdomains
 * @param url
 * @param baseUrl
 * @returns
 */
export function isSameDomain(url: string, baseUrl: string) {
  const parsed1 = getURLobj(url);
  const parsed2 = getURLobj(baseUrl);

  if (parsed1.error || parsed2.error) {
    return false;
  }

  const domain1 = cleanHostname(parsed1.urlObj.hostname)
    .split(".")
    .slice(-2)
    .join(".");
  const domain2 = cleanHostname(parsed2.urlObj.hostname)
    .split(".")
    .slice(-2)
    .join(".");

  return domain1 === domain2;
}

export function isSameSubdomain(url: string, baseUrl: string) {
  const parsed1 = getURLobj(url);
  const parsed2 = getURLobj(baseUrl);

  if (parsed1.error || parsed2.error) {
    return false;
  }

  const domain1 = cleanHostname(parsed1.urlObj.hostname)
    .split(".")
    .slice(-2)
    .join(".");
  const domain2 = cleanHostname(parsed2.urlObj.hostname)
    .split(".")
    .slice(-2)
    .join(".");

  const subdomain1 = cleanHostname(parsed1.urlObj.hostname)
    .split(".")
    .slice(0, -2)
    .join(".");
  const subdomain2 = cleanHostname(parsed2.urlObj.hostname)
    .split(".")
    .slice(0, -2)
    .join(".");

  // Check if the domains are the same and the subdomains are the same
  return domain1 === domain2 && subdomain1 === subdomain2;
}

export const checkAndUpdateURLForMap = (
  url: string,
  ignoreQueryParameters: boolean = false,
) => {
  if (!protocolIncluded(url)) {
    url = `http://${url}`;
  }
  // remove last slash if present
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  const parsed = getURLobj(url);
  if (parsed.error) {
    throw new Error("Invalid URL");
  }

  const typedUrlObj = parsed.urlObj;

  if (typedUrlObj.protocol !== "http:" && typedUrlObj.protocol !== "https:") {
    throw new Error("Invalid URL");
  }

  // remove any query params
  if (ignoreQueryParameters) {
    url = url.split("?")[0].trim();
    typedUrlObj.search = "";
  }

  return { urlObj: typedUrlObj, url };
};

export function removeDuplicateUrls(urls: Array<string>): Array<string> {
  const urlMap = new Map<string, string>();

  for (const url of urls) {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol;
    const hostname = parsedUrl.hostname.replace(/^www\./, "");
    const path = parsedUrl.pathname + parsedUrl.search + parsedUrl.hash;

    const key = `${hostname}${path}`;
    const existing = urlMap.get(key);

    if (existing === undefined) {
      urlMap.set(key, url);
    } else {
      const existingUrl = new URL(existing);
      const existingProtocol = existingUrl.protocol;

      if (protocol === "https:" && existingProtocol === "http:") {
        urlMap.set(key, url);
      } else if (
        protocol === existingProtocol &&
        !parsedUrl.hostname.startsWith("www.") &&
        existingUrl.hostname.startsWith("www.")
      ) {
        urlMap.set(key, url);
      }
    }
  }

  return [...new Set(Array.from(urlMap.values()))];
}

export async function resolveRedirects(
  url: string,
  abort?: AbortSignal,
  mock?: string,
): Promise<string> {
  const targetUrl = protocolIncluded(url) ? url : `http://${url}`;

  if (mock) {
    const mocked = (await loadMock(mock))?.requests.find(
      x => x.options.url === targetUrl && x.options.method === "HEAD",
    );
    if (mocked) {
      return mocked.result.url ?? targetUrl;
    }
  }

  const methods = ["HEAD", "GET"] as const;
  const dispatcher = getSecureDispatcher(false);

  for (const method of methods) {
    const signal = abort
      ? AbortSignal.any([abort, AbortSignal.timeout(2000)])
      : AbortSignal.timeout(2000);

    try {
      const response = await undiciFetch(targetUrl, {
        method,
        redirect: "follow",
        dispatcher,
        signal,
      });

      return response.url;
    } catch (error) {
      if (abort?.aborted) {
        throw error;
      }
    }
  }

  return targetUrl;
}
