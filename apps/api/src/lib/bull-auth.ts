import crypto from "node:crypto";
import { NextFunction, Request, RequestHandler, Response } from "express";

export function createRequireBullAuth(expected: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.params.bullAuthKey;
    if (!provided) {
      return res.status(404).json({ error: "Not found" });
    }
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (
      left.length !== right.length ||
      !crypto.timingSafeEqual(left, right)
    ) {
      return res.status(404).json({ error: "Not found" });
    }
    return next();
  };
}
