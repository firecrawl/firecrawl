import { Request, Response } from "express";
import { config } from "../../config";
import {
  checkKeylessEligibility,
  existingKeylessSignupUrlForIp,
  keylessSignupUrlForIp,
} from "../../lib/keyless";
import {
  keylessFallbackSignupUrl,
  keylessSignupSurface,
} from "../../lib/keyless-signup-link";

/**
 * Internal endpoint for trusted proxies (the hosted MCP) to check, before a
 * keyless tool call, whether a client IP can currently use the tier — without
 * consuming quota. Gated by the shared KEYLESS_PROXY_SECRET; the client IP is
 * supplied via x-firecrawl-keyless-ip. Lets the MCP serve keyless when eligible
 * and return a structured recovery action when the IP is not eligible.
 *
 * An ineligible result carries `signupUrl`, the caller's own signup link, which
 * the MCP relays in its recovery message. `?signup_link=1` asks for the link on
 * an eligible result too, for recovery that eligibility does not cause (a tool
 * that keyless sessions cannot use).
 */
export async function keylessEligibilityController(
  req: Request,
  res: Response,
): Promise<void> {
  const secret = req.headers["x-firecrawl-keyless-secret"];
  if (!config.KEYLESS_PROXY_SECRET || secret !== config.KEYLESS_PROXY_SECRET) {
    res.status(401).json({ eligible: false, error: "Unauthorized" });
    return;
  }

  const ipHeader = req.headers["x-firecrawl-keyless-ip"];
  const ip =
    (typeof ipHeader === "string" ? ipHeader.trim() : "") || req.ip || "";

  const result = await checkKeylessEligibility(ip);
  const wantsLink = !result.eligible || req.query?.signup_link === "1";
  if (!wantsLink) {
    res.status(200).json(result);
    return;
  }
  // No identity to key a link on when the tier is off or the limiter is down.
  // Flagged (rotating) IPs never get a stored row each: they only reuse a link
  // the identity was already given.
  const signupUrl =
    result.reason === "disabled" || result.reason === "error"
      ? keylessFallbackSignupUrl(keylessSignupSurface(req))
      : result.reason === "suspicious"
        ? (await existingKeylessSignupUrlForIp(ip, keylessSignupSurface(req)))
            .url
        : (await keylessSignupUrlForIp(ip, keylessSignupSurface(req))).url;
  res.status(200).json({ ...result, signupUrl });
}
