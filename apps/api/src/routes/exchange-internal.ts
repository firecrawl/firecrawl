import express from "express";
import { config } from "../config";
import {
  exchangeCreditGrantController,
  exchangeCreditGrantsConfigured,
} from "../controllers/exchange-credit-grant";
import { logger } from "../lib/logger";
import { wrap } from "./shared";

// Mounted at the root with full paths, like adminRouter. The route exists only
// on a deployment that can grant, so every method on its path otherwise
// answers like an unknown route.
export const exchangeInternalRouter = express.Router();

if (exchangeCreditGrantsConfigured()) {
  exchangeInternalRouter.post(
    "/exchange-internal/credit-grants",
    wrap(exchangeCreditGrantController),
  );
} else if (config.EXCHANGE_CREDIT_GRANTS_ENABLED) {
  logger.warn(
    "EXCHANGE_CREDIT_GRANTS_ENABLED is set, but credit grants also need EXCHANGE_INTERNAL_SECRET and USE_DB_AUTHENTICATION; the route is disabled.",
  );
}
