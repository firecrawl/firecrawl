import { Request, Response } from "express";
import { config } from "../../config";
import {
  checkKeylessEligibility,
  keylessSignupUrlForIp,
  reportKeylessPromptShown,
} from "../../lib/keyless";
import {
  type KeylessPromptReason,
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
 * any result, for the account-only tool prompt (a tool keyless sessions cannot
 * use), and tags it with that reason whatever the eligibility.
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
  const accountOnlyTool = req.query?.signup_link === "1";
  if (result.eligible && !accountOnlyTool) {
    res.status(200).json(result);
    return;
  }
  const surface = keylessSignupSurface(req);
  const reason: KeylessPromptReason | undefined = accountOnlyTool
    ? "account_only_tool"
    : result.reason === "requests" || result.reason === "credits"
      ? "limit"
      : result.reason === "suspicious"
        ? "suspicious_ip"
        : undefined;
  // A tier that is off or a limiter that is down is not a prompt about this
  // identity, so it gets the regular signup link.
  let signupUrl = keylessFallbackSignupUrl(surface);
  if (reason) {
    const link = keylessSignupUrlForIp(ip, surface, reason);
    signupUrl = link.url;
    // The hosted MCP relays this link as the prompt; this check answers 200.
    reportKeylessPromptShown(ip, surface, reason, 200, link.signupRef);
  }
  res.status(200).json({ ...result, signupUrl });
}
