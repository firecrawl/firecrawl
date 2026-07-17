import { Response } from "express";
import { RequestWithAuth } from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { getACUCTeam } from "../auth";
import { RateLimiterMode } from "../../types";
import { logger } from "../../lib/logger";
import { autumnService } from "../../services/autumn/autumn.service";
import { getTeamBalance } from "../../services/autumn/usage";

const FIRECLAW_COST_PER_PLAY = 100;
const MAX_PLAYS = 10;

interface FireclawResponse {
  success: true;
  credits_billed: number;
  plays: number;
  remaining_credits: number;
}

interface FireclawErrorResponse {
  success: false;
  error: string;
}

export async function fireclawController(
  req: RequestWithAuth<{}, undefined, { plays?: number }>,
  res: Response<FireclawResponse | FireclawErrorResponse>,
): Promise<void> {
  const plays = Math.max(
    1,
    Math.min(MAX_PLAYS, Math.floor(Number(req.body?.plays) || 1)),
  );
  const totalCredits = plays * FIRECLAW_COST_PER_PLAY;

  const chunk =
    req.acuc ??
    (await getACUCTeam(req.auth.team_id, false, false, RateLimiterMode.Scrape));

  if (!chunk) {
    res.status(404).json({
      success: false,
      error: "Could not find team billing information.",
    });
    return;
  }

  // Autumn is the source of truth for credits. The route-level
  // checkCreditsMiddleware only verifies a single play's worth (100), so the
  // full multi-play cost is checked here. Fail open on an Autumn outage
  // (checkCredits returns null), matching checkCreditsMiddleware — don't turn an
  // Autumn outage into a customer outage.
  const creditCheck = await autumnService.checkCredits({
    teamId: req.auth.team_id,
    value: totalCredits,
    properties: { source: "fireclaw", apiKeyId: chunk?.api_key_id ?? null },
  });

  if (creditCheck !== null && !creditCheck.allowed) {
    res.status(402).json({
      success: false,
      error: `Not enough credits. You need ${totalCredits} credits (${plays} play${plays > 1 ? "s" : ""} x ${FIRECLAW_COST_PER_PLAY}) but only have ${creditCheck.remaining}.`,
    });
    return;
  }

  try {
    await billTeam(
      req.auth.team_id,
      totalCredits,
      req.acuc?.api_key_id ?? null,
      { endpoint: "fireclaw" },
    );
  } catch (error) {
    logger.error(`Fireclaw billing failed for team ${req.auth.team_id}`, {
      error,
    });
    res.status(500).json({
      success: false,
      error: "Failed to process billing. Please try again.",
    });
    return;
  }

  // Report the post-bill balance from Autumn (the source of truth). Best-effort:
  // on failure, estimate from the pre-bill credit check minus this charge.
  let remainingCredits: number;
  try {
    const balance = await getTeamBalance(req.auth.team_id);
    remainingCredits = balance?.remaining ?? 0;
  } catch (error) {
    logger.warn("Failed to fetch Autumn balance for fireclaw response", {
      error,
      teamId: req.auth.team_id,
    });
    remainingCredits = Math.max(
      0,
      (creditCheck?.remaining ?? totalCredits) - totalCredits,
    );
  }

  res.json({
    success: true,
    credits_billed: totalCredits,
    plays,
    remaining_credits: remainingCredits,
  });
}
