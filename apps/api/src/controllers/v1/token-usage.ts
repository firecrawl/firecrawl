import { Request, Response } from "express";
import { RequestWithAuth } from "./types";
import { getACUC, getACUCTeam } from "../auth";
import { logger } from "../../lib/logger";
import { RateLimiterMode } from "../../types";

export async function tokenUsageController(
  req: RequestWithAuth,
  res: Response,
): Promise<void> {
  try {
    // If we already have the token usage info from auth, use it
    if (req.acuc) {
      res.json({
        success: true,
        data: {
          remaining_tokens: req.acuc.remaining_credits,
        },
      });
      return;
    }

    // Otherwise fetch fresh data
    const chunk = await getACUCTeam(req.auth.team_id, false, false, RateLimiterMode.Extract);
    if (!chunk) {
      res.status(404).json({
        success: false,
        error: "Could not find token usage information",
      });
      return;
    }

    res.json({
      success: true,
      data: {
        remaining_tokens: chunk.remaining_credits,
      },
    });
  } catch (error) {
    logger.error("Error in token usage controller:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error while fetching token usage",
    });
  }
}
