import type { Logger } from "winston";
import { config } from "../config";
import type { SearchV2Response } from "../lib/entities";

export const WEB_RISK_CREDITS_PER_SCANNED_URL = 2;

export const DEFAULT_WEB_RISK_THREAT_TYPES = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
] as const;

export type WebRiskThreatType =
  | (typeof DEFAULT_WEB_RISK_THREAT_TYPES)[number]
  | "SOCIAL_ENGINEERING_EXTENDED_COVERAGE";

export type FilterRiskyURLsOptions =
  | boolean
  | {
      enabled?: boolean;
      threatTypes?: WebRiskThreatType[];
      failOpen?: boolean;
    };

type NormalizedFilterRiskyURLsOptions = {
  enabled: boolean;
  threatTypes: WebRiskThreatType[];
  failOpen: boolean;
};

type GoogleWebRiskResponse = {
  threat?: {
    threatTypes?: WebRiskThreatType[];
    expireTime?: string;
  };
};

type UrlScanResult = {
  url: string;
  risky: boolean;
  threatTypes: WebRiskThreatType[];
};

type WebRiskFilteringResult = {
  response: SearchV2Response;
  scannedUrls: number;
  filteredUrls: number;
};

export function normalizeFilterRiskyURLsOptions(
  options: FilterRiskyURLsOptions | undefined,
): NormalizedFilterRiskyURLsOptions {
  if (!options) {
    return {
      enabled: false,
      threatTypes: [...DEFAULT_WEB_RISK_THREAT_TYPES],
      failOpen: true,
    };
  }

  if (options === true) {
    return {
      enabled: true,
      threatTypes: [...DEFAULT_WEB_RISK_THREAT_TYPES],
      failOpen: true,
    };
  }

  return {
    enabled: options.enabled ?? true,
    threatTypes: options.threatTypes?.length
      ? options.threatTypes
      : [...DEFAULT_WEB_RISK_THREAT_TYPES],
    failOpen: options.failOpen ?? true,
  };
}

async function scanUrlWithGoogleWebRisk(
  url: string,
  threatTypes: WebRiskThreatType[],
): Promise<UrlScanResult> {
  if (!config.GOOGLE_WEB_RISK_API_KEY) {
    throw new Error("GOOGLE_WEB_RISK_API_KEY is not configured");
  }

  const requestUrl = new URL("https://webrisk.googleapis.com/v1/uris:search");
  requestUrl.searchParams.set("key", config.GOOGLE_WEB_RISK_API_KEY);
  requestUrl.searchParams.set("uri", url);
  for (const threatType of threatTypes) {
    requestUrl.searchParams.append("threatTypes", threatType);
  }

  const response = await fetch(requestUrl);
  if (!response.ok) {
    throw new Error(
      `Google Web Risk returned ${response.status}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as GoogleWebRiskResponse;
  const matchedThreatTypes = body.threat?.threatTypes ?? [];
  return {
    url,
    risky: matchedThreatTypes.length > 0,
    threatTypes: matchedThreatTypes,
  };
}

function uniqueResultUrls(response: SearchV2Response): string[] {
  const urls = [
    ...(response.web ?? []).map(result => result.url),
    ...(response.news ?? []).map(result => result.url).filter(Boolean),
    ...(response.images ?? []).map(result => result.url).filter(Boolean),
  ];

  return [...new Set(urls)].filter((url): url is string => !!url);
}

export async function filterSearchResponseWithWebRisk(
  response: SearchV2Response,
  options: FilterRiskyURLsOptions | undefined,
  logger: Logger,
): Promise<WebRiskFilteringResult> {
  const normalized = normalizeFilterRiskyURLsOptions(options);
  if (!normalized.enabled) {
    return { response, scannedUrls: 0, filteredUrls: 0 };
  }

  const urlsToScan = uniqueResultUrls(response);
  if (urlsToScan.length === 0) {
    return { response, scannedUrls: 0, filteredUrls: 0 };
  }

  let scanResults: UrlScanResult[];
  try {
    scanResults = await Promise.all(
      urlsToScan.map(url =>
        scanUrlWithGoogleWebRisk(url, normalized.threatTypes),
      ),
    );
  } catch (error) {
    if (normalized.failOpen) {
      logger.warn("Google Web Risk filtering failed open", { error });
      return { response, scannedUrls: 0, filteredUrls: 0 };
    }

    throw error;
  }

  const riskyUrls = new Set(
    scanResults.filter(result => result.risky).map(result => result.url),
  );
  if (riskyUrls.size === 0) {
    return { response, scannedUrls: scanResults.length, filteredUrls: 0 };
  }

  return {
    response: {
      ...response,
      web: response.web?.filter(result => !riskyUrls.has(result.url)),
      news: response.news?.filter(
        result => !result.url || !riskyUrls.has(result.url),
      ),
      images: response.images?.filter(
        result => !result.url || !riskyUrls.has(result.url),
      ),
    },
    scannedUrls: scanResults.length,
    filteredUrls: riskyUrls.size,
  };
}
