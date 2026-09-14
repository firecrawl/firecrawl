import type { NextFunction, Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";

const REQUEST_ID_HEADER = "X-Request-ID";
const REQUEST_ID_MAX_BYTES = 256;

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

function getIncomingRequestId(req: Request): string | undefined {
  const raw = req.get(REQUEST_ID_HEADER);
  if (!raw) return undefined;

  const value = raw.trim();
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > REQUEST_ID_MAX_BYTES ||
    /[\x00-\x1f\x7f-\x9f]/.test(value)
  ) {
    return undefined;
  }

  return value;
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const requestId = getIncomingRequestId(req) ?? uuidv7();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
