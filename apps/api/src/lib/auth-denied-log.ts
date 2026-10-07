import type { Request } from "express";
import type { AuthCreditUsageChunk } from "../controllers/v1/types";
import { getRoutePattern } from "./http-metrics";
import { logger } from "./logger";

export type AuthDenialReason =
  | "missing_credentials"
  | "malformed_authorization"
  | "malformed_key"
  | "unknown_key"
  | "invalid_mcp_credential"
  | "invalid_oauth_token"
  | "oauth_purpose_mismatch"
  | "oauth_team_mismatch"
  | "team_banned"
  | "ip_restricted"
  | "endpoint_restricted"
  | "keyless_ip_ineligible"
  | "keyless_ip_suspicious"
  | "keyless_limiter_unavailable"
  | "agent_key_blocked"
  | "agent_key_verification_expired";

/**
 * Writes the single `auth/denied` line for a request refused access. Pass `key`
 * only when it came from a resolved API key: preview and keyless chunks carry
 * the client IP in their team id. Never log the credential or the client IP.
 */
export function logAuthDenied(
  req: Request,
  status: number,
  reason: AuthDenialReason,
  key?: Pick<AuthCreditUsageChunk, "team_id" | "api_key_id">,
): void {
  logger.warn("Request denied", {
    canonicalLog: "auth/denied",
    reason,
    status,
    method: req.method,
    route:
      typeof req.path === "string"
        ? `${req.baseUrl ?? ""}${getRoutePattern(req)}`
        : undefined,
    teamId: key?.team_id,
    apiKeyId: key?.api_key_id,
  });
}
