/**
 * Evidence-based anti-bot / challenge-page classification.
 *
 * A bare 4xx is NOT enough to call something anti-bot — plenty of sites return
 * 403 while still serving the real document (observed on anesidoralove.com,
 * which returns 403 with the full 550 KB article). Callers that spend real
 * resources on a stealth retry need to look at the response body, so this
 * module separates "we saw a challenge page" from "we saw a blocking status".
 */

/** Bounded prefix scanned for markers, so a huge document can't stall the loop. */
const SCAN_PREFIX_BYTES = 256 * 1024;

/**
 * Bodies larger than this are not treated as challenge pages. Interstitials are
 * small (observed: 308 B Akamai, 25 KB reCAPTCHA, 27 KB Cloudflare); a
 * multi-hundred-KB document that happens to contain a marker string is far more
 * likely to be real content than a challenge.
 */
const MAX_CHALLENGE_BODY_BYTES = 400 * 1024;

/** Statuses that indicate the origin refused us, as opposed to a missing page. */
const BLOCKING_STATUS_CODES = [403, 429];

/**
 * Challenge fingerprints. Every entry is a conjunction: all of its needles must
 * appear (case-insensitively) in the scanned prefix. Single-needle entries are
 * reserved for strings that essentially cannot appear outside a challenge page;
 * anything that a normal page might legitimately embed (a reCAPTCHA widget on a
 * contact form, for instance) is paired with a challenge-specific phrase.
 */
const CHALLENGE_SIGNATURES: { vendor: string; needles: string[] }[] = [
  { vendor: "cloudflare", needles: ["__cf_chl"] },
  { vendor: "cloudflare", needles: ["cf_chl_opt"] },
  { vendor: "cloudflare", needles: ["/cdn-cgi/challenge-platform/"] },
  { vendor: "cloudflare", needles: ["cf-browser-verification"] },
  { vendor: "cloudflare", needles: ["<title>just a moment"] },
  { vendor: "recaptcha", needles: ["boq-recaptcha"] },
  { vendor: "recaptcha", needles: ["recaptcha", "checking your browser"] },
  { vendor: "datadome", needles: ["geo.captcha-delivery.com"] },
  { vendor: "datadome", needles: ["datadome", "captcha"] },
  { vendor: "perimeterx", needles: ["px-captcha"] },
  { vendor: "perimeterx", needles: ["perimeterx", "blocked"] },
  { vendor: "imperva", needles: ["incapsula incident"] },
  { vendor: "imperva", needles: ["_incapsula_resource"] },
  { vendor: "akamai", needles: ["errors.edgesuite.net"] },
  { vendor: "akamai", needles: ["access denied", "reference #"] },
  { vendor: "awswaf", needles: ["awswafintegration"] },
  { vendor: "awswaf", needles: ["token.awswaf.com"] },
  { vendor: "sucuri", needles: ["sucuri website firewall"] },
  { vendor: "hcaptcha", needles: ["hcaptcha", "verify you are human"] },
  {
    vendor: "generic",
    needles: ["enable javascript and cookies to continue"],
  },
];

type AntibotConfidence =
  /** A known challenge/interstitial fingerprint was found in the body. */
  | "confirmed"
  /** The origin refused us (403/429) but the body carries no known fingerprint. */
  | "suspected"
  /** No anti-bot evidence — 404s, DNS/TLS errors, ordinary pages. */
  | "none";

export type AntibotDetection = {
  confidence: AntibotConfidence;
  /** Stable, secret-free label for logs and metrics. */
  failureClass: string;
  /** Vendor behind a `confirmed` verdict. */
  vendor?: string;
  statusCode: number;
};

/**
 * Signatures of our *own* SSRF controls refusing a target.
 *
 * The browser microservices report a blocked internal address the same way a
 * site reports a bot block — HTTP 403 — so status alone cannot tell them
 * apart. Misreading one as anti-bot would send the stealth browser off to
 * retry an internal address, which is both wasted work and precisely the
 * behaviour the SSRF policy exists to prevent.
 */
const SSRF_BLOCK_SIGNATURES = [
  "blocked insecure target url",
  "connection violated security rules",
  "private/internal address",
  "target resolves to a private",
  "violates ssrf policy",
];

export function classifyAntibotResponse({
  statusCode,
  html,
  contentType,
  pageError,
}: {
  statusCode: number;
  html?: string;
  contentType?: string;
  /** Engine-reported error string, if any. */
  pageError?: string;
}): AntibotDetection {
  if (pageError !== undefined) {
    const lowered = pageError.toLowerCase();
    if (SSRF_BLOCK_SIGNATURES.some(signature => lowered.includes(signature))) {
      return {
        confidence: "none",
        failureClass: "blocked_internal_target",
        statusCode,
      };
    }
  }

  const isHtmlish =
    contentType === undefined ||
    contentType.toLowerCase().includes("html") ||
    contentType.toLowerCase().includes("text/plain");

  if (
    html !== undefined &&
    isHtmlish &&
    html.length <= MAX_CHALLENGE_BODY_BYTES
  ) {
    const haystack = html.slice(0, SCAN_PREFIX_BYTES).toLowerCase();
    for (const signature of CHALLENGE_SIGNATURES) {
      if (signature.needles.every(needle => haystack.includes(needle))) {
        return {
          confidence: "confirmed",
          failureClass: `antibot_challenge:${signature.vendor}`,
          vendor: signature.vendor,
          statusCode,
        };
      }
    }
  }

  if (BLOCKING_STATUS_CODES.includes(statusCode)) {
    return {
      confidence: "suspected",
      failureClass: `http_${statusCode}_blocked`,
      statusCode,
    };
  }

  return {
    confidence: "none",
    failureClass: `http_${statusCode}`,
    statusCode,
  };
}

/** True when `detection` clears the configured minimum confidence bar. */
export function meetsConfidenceThreshold(
  detection: AntibotDetection,
  minimum: "confirmed" | "suspected",
): boolean {
  if (detection.confidence === "none") return false;
  if (minimum === "suspected") return true;
  return detection.confidence === "confirmed";
}

/**
 * Anti-bot fallback state, carried on `Meta` as a mutable holder so it survives
 * the shallow `{...meta}` copies made per engine attempt and the outer
 * feature-toggle retry loop. This is what enforces "one stealth attempt per
 * scrape job" no matter how many times the waterfall restarts.
 */
export type AntibotFallbackState = {
  /** Classification of the response that first blocked this job. */
  detection?: AntibotDetection;
  camoufoxAttempts: number;
  camoufoxOutcome?:
    | "success"
    | "failure"
    | "skipped_not_applicable"
    | "skipped_already_attempted"
    | "skipped_domain_filter"
    | "service_unavailable";
  /** Reason string for a skip/failure, safe to log. */
  camoufoxDetail?: string;
  camoufoxElapsedMs?: number;
  flaresolverrAttempts: number;
  flaresolverrOutcome?:
    | "success"
    | "failure"
    | "skipped_not_applicable"
    | "skipped_already_attempted"
    | "skipped_domain_filter"
    | "challenge_not_cleared"
    | "service_unavailable";
  /** Reason string for a skip/failure, safe to log. */
  flaresolverrDetail?: string;
  flaresolverrElapsedMs?: number;
};

export function createAntibotFallbackState(): AntibotFallbackState {
  return { camoufoxAttempts: 0, flaresolverrAttempts: 0 };
}
