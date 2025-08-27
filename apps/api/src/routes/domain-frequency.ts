import express from "express";
import { Request, Response } from "express";
import {
  getTopDomains,
  getDomainFrequency,
  getDomainFrequencyStats,
  getDomainFrequencyQueueLength,
} from "../services";
import { logger } from "../lib/logger";

const domainFrequencyRouter = express.Router();

// Get top domains by frequency
domainFrequencyRouter.get(
  `/domain-frequency/${process.env.BULL_AUTH_KEY}/top`,
  async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const topDomains = await getTopDomains(Math.min(limit, 1000)); // Cap at 1000

      res.json({
        success: true,
        data: topDomains,
      });
    } catch (error) {
      logger.error("Failed to get top domains", { error });
      res.status(500).json({
        success: false,
        error: "Failed to retrieve top domains",
      });
    }
  },
);

// Get frequency for a specific domain
domainFrequencyRouter.get(
  `/domain-frequency/${process.env.BULL_AUTH_KEY}/domain/:domain`,
  async (req: Request, res: Response) => {
    try {
      const { domain } = req.params;
      const frequency = await getDomainFrequency(domain);

      if (frequency === null) {
        res.status(404).json({
          success: false,
          error: "Domain not found",
        });
        return;
      }

      res.json({
        success: true,
        data: {
          domain,
          frequency,
        },
      });
    } catch (error) {
      logger.error("Failed to get domain frequency", {
        error,
        domain: req.params.domain,
      });
      res.status(500).json({
        success: false,
        error: "Failed to retrieve domain frequency",
      });
    }
  },
);

// Get overall statistics
domainFrequencyRouter.get(
  `/domain-frequency/${process.env.BULL_AUTH_KEY}/stats`,
  async (req: Request, res: Response) => {
    try {
      const [stats, queueLength] = await Promise.all([
        getDomainFrequencyStats(),
        getDomainFrequencyQueueLength(),
      ]);

      res.json({
        success: true,
        data: {
          ...stats,
          pendingUpdates: queueLength,
        },
      });
    } catch (error) {
      logger.error("Failed to get domain frequency stats", { error });
      res.status(500).json({
        success: false,
        error: "Failed to retrieve statistics",
      });
    }
  },
);

export default domainFrequencyRouter;
