import type { NextFunction, Request, Response } from "express";
import { claimIdempotencyKey } from "./claim";

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  (async () => {
    if (req.headers["x-idempotency-key"]) {
      const claimed = await claimIdempotencyKey(req);
      if (!claimed) {
        if (!res.headersSent) {
          return res
            .status(409)
            .json({ success: false, error: "Idempotency key already used" });
        }
        return;
      }
    }
    next();
  })().catch(err => next(err));
}
