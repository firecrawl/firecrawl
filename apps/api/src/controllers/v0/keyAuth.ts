import { RateLimiterMode } from "../../types";

import { Request, Response } from "express";
import { authenticateV0 } from "./auth";
import { redisEvictConnection } from "../../../src/services/redis";
import { logger } from "../../lib/logger";
import { getScrapeZDR } from "../../lib/zdr-helpers";

export const keyAuthController = async (req: Request, res: Response) => {
  try {
    // make sure to authenticate user first, Bearer <token>
    const auth = await authenticateV0(req, res, RateLimiterMode.Account);
    if (!auth) return;

    if (getScrapeZDR(auth.chunk?.flags) === "forced") {
      return res.status(400).json({
        error:
          "Your team has zero data retention enabled. This is not supported on the v0 API. Please update your code to use the v1 API.",
      });
    }

    redisEvictConnection.sadd("teams_using_v0", auth.team_id).catch(error =>
      logger.error("Failed to add team to teams_using_v0", {
        error,
        team_id: auth.team_id,
      }),
    );

    redisEvictConnection
      .sadd("teams_using_v0:" + auth.team_id, "keyAuth")
      .catch(error =>
        logger.error("Failed to add team to teams_using_v0 (2)", {
          error,
          team_id: auth.team_id,
        }),
      );

    // if success, return success: true
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
