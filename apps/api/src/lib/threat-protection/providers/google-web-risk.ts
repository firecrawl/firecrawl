import { config } from "../../../config";
import type { RawVerdict, ThreatProvider } from "../types";

// Google Web Risk provider ("normal" threat protection mode). Uses the
// uris.search Lookup API: a single GET returns the threat types (if any) the
// URI is flagged for. https://cloud.google.com/web-risk/docs/lookup-api
//
// Web Risk gives a boolean-ish signal (flagged for a threat type or not), not
// a granular score — so we normalize any confirmed threat to riskScore 100 and
// a clean lookup to 0, and surface the threat types as category strings.

const PROVIDER: ThreatProvider = "google-web-risk";

const THREAT_TYPES = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
] as const;

type WebRiskSearchResponse = {
  threat?: {
    threatTypes?: string[];
    expireTime?: string;
  };
};

function isGoogleWebRiskConfigured(): boolean {
  return (
    typeof config.GOOGLE_WEB_RISK_API_KEY === "string" &&
    config.GOOGLE_WEB_RISK_API_KEY.trim().length > 0
  );
}

/**
 * Look up a domain against Google Web Risk. Throws on any transport/API error
 * so the caller can apply the org's failurePolicy.
 */
export async function fetchGoogleWebRiskVerdict(
  domain: string,
  options?: { signal?: AbortSignal },
): Promise<RawVerdict> {
  if (!isGoogleWebRiskConfigured()) {
    throw new Error("Google Web Risk is not configured");
  }

  const params = new URLSearchParams();
  for (const threatType of THREAT_TYPES) {
    params.append("threatTypes", threatType);
  }
  params.append("uri", `http://${domain}/`);
  params.append("key", config.GOOGLE_WEB_RISK_API_KEY!);

  const response = await fetch(
    `${config.GOOGLE_WEB_RISK_API_URL}/v1/uris:search?${params.toString()}`,
    {
      method: "GET",
      signal: options?.signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Google Web Risk lookup failed with status ${response.status}`,
    );
  }

  const body = (await response.json()) as WebRiskSearchResponse;
  const threatTypes = body.threat?.threatTypes ?? [];

  return {
    provider: PROVIDER,
    riskScore: threatTypes.length > 0 ? 100 : 0,
    categories: threatTypes,
    domainAgeDays: null,
    countryCode: null,
    fromCache: false,
    raw: body,
  };
}
