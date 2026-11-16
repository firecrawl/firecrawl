import express from "express";
import { exchangeCreditGrantController } from "../controllers/exchange-credit-grant";
import { wrap } from "./shared";

// Mounted at the root with full paths, so the controller's not-found answer
// names the same path an unknown route's would.
export const exchangeInternalRouter = express.Router();

exchangeInternalRouter.post(
  "/exchange-internal/credit-grants",
  wrap(exchangeCreditGrantController),
);
