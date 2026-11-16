import { randomUUID } from "crypto";
import type { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { orgIdFromAcuc } from "../../lib/team-org";
import {
  createDatasetOrder,
  DatasetOrderError,
  getDatasetOrder,
  settleDatasetOrder,
} from "../../services/datasets/orders";
import type { RequestWithAuth } from "./types";

const createBodySchema = z.looseObject({ maxCredits: z.int().min(0) });

/** Answers `{ success: true, data }`, or a DatasetOrderError as `{ success: false, code, error }`. */
function datasetOrderRoute<Params = {}>(
  handler: (req: RequestWithAuth<Params, any, any>) => Promise<unknown>,
) {
  return async (req: RequestWithAuth<Params, any, any>, res: Response) => {
    try {
      return res.status(200).json({ success: true, data: await handler(req) });
    } catch (error) {
      if (!(error instanceof DatasetOrderError)) throw error;
      return res.status(error.status).json({
        ...error.details,
        success: false,
        code: error.code,
        error: error.message,
      });
    }
  };
}

export const createDatasetOrderController = datasetOrderRoute(async req => {
  const body = createBodySchema.safeParse(req.body);
  if (!body.success)
    throw new DatasetOrderError(
      400,
      "invalid_request",
      "Send the order with maxCredits, the most credits it may hold, as a whole number.",
    );
  const { maxCredits, ...spec } = body.data;
  return createDatasetOrder({
    teamId: req.auth.team_id,
    orgId: orgIdFromAcuc(req.acuc),
    apiKeyId: req.acuc?.api_key_id ?? null,
    idempotencyKey: req.header("x-idempotency-key")?.trim() || randomUUID(),
    spec,
    maxCredits,
  });
});

export const getDatasetOrderController = datasetOrderRoute<{ id: string }>(
  req => getDatasetOrder(req.auth.team_id, req.params.id),
);

export const settleDatasetOrderController = datasetOrderRoute<{ id: string }>(
  async req => {
    if (!config.DATASETS_BUILDER_TEAM_IDS?.includes(req.auth.team_id))
      throw new DatasetOrderError(
        403,
        "forbidden",
        "This team may not settle dataset orders.",
      );
    const { status, holdState } = await settleDatasetOrder(req.params.id);
    return { status, holdState };
  },
);
