import type { Request, Response } from "express";
import { service, type Caller } from "../../service";
import type { RateLimiterMode } from "../../types";
import type { AuthCreditUsageChunk } from "../v1/types";

type LegacyCaller = Caller & {
  chunk?: AuthCreditUsageChunk | null;
};

/**
 * Authenticates a legacy v0 request through `service.modules.auth`, preserving
 * v0's `{ error }` refusal body and any refusal headers.
 */
export async function authenticateV0(
  req: Request,
  res: Response,
  mode: RateLimiterMode,
): Promise<{ team_id: string; chunk: AuthCreditUsageChunk | null } | null> {
  const result = await service.modules.auth.authenticate(req, { kind: mode });
  if (!result.ok) {
    if (!res.headersSent) {
      for (const [name, value] of Object.entries(
        result.refusal.headers ?? {},
      )) {
        res.setHeader(name, value);
      }
      res.status(result.refusal.status).json({
        error: result.refusal.body.error,
      });
    }
    return null;
  }

  if (!res.headersSent) {
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      res.setHeader(name, value);
    }
  }

  const caller = result.caller as LegacyCaller;
  req.caller = result.caller;
  return {
    team_id: caller.teamId,
    chunk: caller.chunk ?? null,
  };
}
