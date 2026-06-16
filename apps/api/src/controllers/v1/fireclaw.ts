import { Response } from "express";
import { RequestWithAuth } from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { getACUCTeam } from "../auth";
import { RateLimiterMode } from "../../types";
import { logger } from "../../lib/logger";

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

  if (chunk.remaining_credits < totalCredits) {
    res.status(402).json({
      success: false,
      error: `Not enough credits. You need ${totalCredits} credits (${plays} play${plays > 1 ? "s" : ""} x ${FIRECLAW_COST_PER_PLAY}) but only have ${chunk.remaining_credits}.`,
    });
    return;
  }

  try {
    await billTeam(
      req.auth.team_id,
      req.acuc?.sub_id ?? undefined,
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

  const updatedChunk = await getACUCTeam(
    req.auth.team_id,
    false,
    false,
    RateLimiterMode.Scrape,
  );

  res.json({
    success: true,
    credits_billed: totalCredits,
    plays,
    remaining_credits:
      updatedChunk?.remaining_credits ?? chunk.remaining_credits - totalCredits,
  });
}
