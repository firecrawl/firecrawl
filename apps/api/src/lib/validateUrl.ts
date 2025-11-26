import * as undici from "undici";
import { getSecureDispatcher } from "../scraper/scrapeURL/engines/utils/safeFetch";

export const protocolIncluded = (url: string) => {
  // if :// not in the start of the url assume http (maybe https?)
  // regex checks if :// appears before any .
  return /^([^.:]+:\/\/)/i.test(url);
};

const getURLobj = (s: string) => {
  // URL fails if we dont include the protocol ie google.com
  let error = false;
  let urlObj = {};
  try {
    urlObj = new URL(s);
  } catch (err) {
    error = true;
  }
  return { error, urlObj };
};

export const checkAndUpdateURL = (url: string) => {
  if (!protocolIncluded(url)) {
    url = `http://${url}`;
  }

  const { error, urlObj } = getURLobj(url);
  if (error) {
    throw new Error("Invalid URL");
  }

  const typedUrlObj = urlObj as URL;

  if (typedUrlObj.protocol !== "http:" && typedUrlObj.protocol !== "https:") {
    throw new Error("Invalid URL");
  }

  return { urlObj: typedUrlObj, url: url };
};

export const checkUrl = (url: string) => {
  const { error, urlObj } = getURLobj(url);
  if (error) {
    throw new Error("Invalid URL");
  }

  const typedUrlObj = urlObj as URL;

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
  const { urlObj: urlObj1, error: error1 } = getURLobj(url);
  const { urlObj: urlObj2, error: error2 } = getURLobj(baseUrl);

  if (error1 || error2) {
    return false;
  }

  const typedUrlObj1 = urlObj1 as URL;
  const typedUrlObj2 = urlObj2 as URL;

  const cleanHostname = (hostname: string) => {
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  };

  const domain1 = cleanHostname(typedUrlObj1.hostname)
    .split(".")
    .slice(-2)
    .join(".");
  const domain2 = cleanHostname(typedUrlObj2.hostname)
    .split(".")
    .slice(-2)
    .join(".");

  return domain1 === domain2;
}

export function isSameSubdomain(url: string, baseUrl: string) {
  const { urlObj: urlObj1, error: error1 } = getURLobj(url);
  const { urlObj: urlObj2, error: error2 } = getURLobj(baseUrl);

  if (error1 || error2) {
    return false;
  }

  const typedUrlObj1 = urlObj1 as URL;
  const typedUrlObj2 = urlObj2 as URL;

  const cleanHostname = (hostname: string) => {
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  };

  const domain1 = cleanHostname(typedUrlObj1.hostname)
    .split(".")
    .slice(-2)
    .join(".");
  const domain2 = cleanHostname(typedUrlObj2.hostname)
    .split(".")
    .slice(-2)
    .join(".");

  const subdomain1 = cleanHostname(typedUrlObj1.hostname)
    .split(".")
    .slice(0, -2)
    .join(".");
  const subdomain2 = cleanHostname(typedUrlObj2.hostname)
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

  const { error, urlObj } = getURLobj(url);
  if (error) {
    throw new Error("Invalid URL");
  }

  const typedUrlObj = urlObj as URL;

  if (typedUrlObj.protocol !== "http:" && typedUrlObj.protocol !== "https:") {
    throw new Error("Invalid URL");
  }

  // remove any query params
  if (ignoreQueryParameters) {
    url = url.split("?")[0].trim();
    typedUrlObj.search = "";
  }

  return { urlObj: typedUrlObj, url: url };
};

export function removeDuplicateUrls(urls: string[]): string[] {
  const urlMap = new Map<string, string>();

  for (const url of urls) {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol;
    const hostname = parsedUrl.hostname.replace(/^www\./, "");
    const path = parsedUrl.pathname + parsedUrl.search + parsedUrl.hash;

    const key = `${hostname}${path}`;

    if (!urlMap.has(key)) {
      urlMap.set(key, url);
    } else {
      const existingUrl = new URL(urlMap.get(key)!);
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
): Promise<string> {
  const targetUrl = protocolIncluded(url) ? url : `http://${url}`;

  const methods = ["HEAD", "GET"] as const;

  for (const method of methods) {
    const signal = abort
      ? AbortSignal.any([abort, AbortSignal.timeout(2000)])
      : AbortSignal.timeout(2000);

    try {
      const response = await undici.fetch(targetUrl, {
        method,
        redirect: "follow",
        dispatcher: getSecureDispatcher(false),
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
