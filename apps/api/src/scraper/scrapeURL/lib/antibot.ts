/**
 * Utility functions for detecting anti-bot challenge and block pages
 * (e.g. Cloudflare, DataDome, PerimeterX, Akamai, CAPTCHAs, HTTP 403/401/429).
 */

const ANTIBOT_STATUS_CODES = new Set([401, 403, 429]);

const CLOUDFLARE_PATTERNS = [
  /just a moment\.\.\./i,
  /attention required!\s*\|\s*cloudflare/i,
  /cf-browser-verification/i,
  /cf_chl_prog/i,
  /challenge-platform/i,
  /cf-turnstile/i,
  /challenges\.cloudflare\.com/i,
  /checking your browser before accessing/i,
  /enable javascript and cookies to continue/i,
  /(?:please\s+)?verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human/i,
  /cloudflare\s+ray\s+id/i,
];

const DATADOME_PATTERNS = [
  /geo\.captcha-delivery\.com/i,
  /protected\s+by\s+datadome/i,
  /blocked\s+by\s+datadome/i,
  /datadome\.js/i,
  /datadome-captcha/i,
  /access to this page has been denied.*datadome/i,
];

const GENERAL_CAPTCHA_AND_BOT_PATTERNS = [
  /px-captcha/i,
  /perimeterx/i,
  /_px3/i,
  /press\s+&\s+hold\s+to\s+confirm\s+you\s+are\s+a\s+human/i,
  /incapsula\s+incident\s+id/i,
  /_incapsula_resource/i,
  /shieldsquare/i,
  /distil_captcha/i,
  /<title>(?:robot check|security check|human verification|access denied|bot verification|security verification)<\/title>/i,
  /please\s+solve\s+(?:the|this)\s+captcha/i,
  /recaptcha\/api\.js/i,
  /hcaptcha\.com\/1\/api\.js/i,
];

/**
 * Checks whether a response (status code and/or content) indicates an anti-bot challenge or block page.
 */
export function isAntiBotBlock(
  statusCode?: number,
  html?: string,
  markdown?: string,
): boolean {
  if (statusCode !== undefined && ANTIBOT_STATUS_CODES.has(statusCode)) {
    return true;
  }

  const contentToCheck = (html ? html + " " : "") + (markdown ?? "");
  if (!contentToCheck.trim()) {
    return false;
  }

  for (const pattern of CLOUDFLARE_PATTERNS) {
    if (pattern.test(contentToCheck)) {
      return true;
    }
  }

  for (const pattern of DATADOME_PATTERNS) {
    if (pattern.test(contentToCheck)) {
      return true;
    }
  }

  for (const pattern of GENERAL_CAPTCHA_AND_BOT_PATTERNS) {
    if (pattern.test(contentToCheck)) {
      return true;
    }
  }

  return false;
}
