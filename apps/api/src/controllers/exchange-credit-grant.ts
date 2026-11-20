import type { Request, Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { logger as _logger } from "../lib/logger";
import { notFoundHandler } from "../lib/not-found";
import { timingSafeSecretEqual } from "../lib/secret-compare";
import { orgIdFromAcuc } from "../lib/team-org";
import {
  autumnService,
  CREDITS_FEATURE_ID,
} from "../services/autumn/autumn.service";
import { getACUCTeam } from "./auth";

const logger = _logger.child({
  module: "api/exchange-internal",
  method: "exchangeCreditGrantController",
});

const creditGrantSchema = z.object({
  grantId: z.guid(),
  kind: z.enum(["earning", "reward_refund"]),
  teamId: z.guid(),
  credits: z.number().int().positive(),
});

/**
 * Whether this deployment can grant: the flag, the shared secret, and database
 * authentication, without which no team resolves to an organization.
 */
export function exchangeCreditGrantsConfigured(): boolean {
  return (
    config.EXCHANGE_CREDIT_GRANTS_ENABLED &&
    Boolean(config.EXCHANGE_INTERNAL_SECRET) &&
    config.USE_DB_AUTHENTICATION === true
  );
}

/**
 * Adds credits to a team's balance on behalf of the Exchange service, which
 * authenticates with the shared secret. A 400 or 422 is final for that grant.
 * A 503 is safe to retry with the same grantId: the idempotency key makes
 * every attempt the same grant.
 */
export async function exchangeCreditGrantController(
  req: Request,
  res: Response,
) {
  // Checked before the secret, so a deployment that cannot grant answers
  // exactly like an unknown route.
  if (!exchangeCreditGrantsConfigured()) {
    return notFoundHandler(req, res, () => {});
  }

  if (
    !timingSafeSecretEqual(
      req.headers["x-exchange-secret"],
      config.EXCHANGE_INTERNAL_SECRET,
    )
  ) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const parsed = creditGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      code: "invalid_body",
      error: "Invalid request body.",
      details: parsed.error.issues,
    });
  }
  const { grantId, kind, teamId, credits } = parsed.data;

  const answer = (
    status: number,
    outcome: string,
    body: Record<string, unknown>,
  ) => {
    logger.info("Exchange credit grant processed", {
      grantId,
      kind,
      teamId,
      credits,
      outcome,
    });
    return res.status(status).json(body);
  };

  const maxCredits = config.EXCHANGE_CREDIT_GRANT_MAX_CREDITS;
  if (credits > maxCredits) {
    return answer(400, "grant_too_large", {
      success: false,
      code: "grant_too_large",
      error: `A grant cannot exceed ${maxCredits} credits.`,
    });
  }

  // The org always comes from the team's own record, never from the caller.
  let orgId: string | null;
  try {
    orgId = orgIdFromAcuc(await getACUCTeam(teamId));
  } catch (error) {
    logger.warn("Failed to resolve the org for an Exchange credit grant", {
      grantId,
      teamId,
      error,
    });
    return answer(503, "org_lookup_failed", {
      success: false,
      error: "The team could not be looked up.",
      retryable: true,
    });
  }
  if (orgId === null) {
    return answer(422, "unknown_team", {
      success: false,
      code: "unknown_team",
      error: "The team does not exist or has no organization.",
    });
  }

  const confirmed = await autumnService.refundCredits({
    teamId,
    orgId,
    value: credits,
    featureId: CREDITS_FEATURE_ID,
    idempotencyKey: `fc:grant:exchange:${grantId}`,
    // refundCredits stamps its own `source`, so the origin goes under a
    // name it keeps.
    properties: { grantSource: "exchange", kind, grantId },
  });
  if (!confirmed) {
    return answer(503, "billing_unconfirmed", {
      success: false,
      error: "Billing did not confirm the grant.",
      retryable: true,
    });
  }
  return answer(200, "granted", { success: true });
}
