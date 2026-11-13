import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";
import type { RequestWithAuth } from "../controllers/v1/types";
import { externalRequestId } from "../lib/external-request-id";
import { logger as rootLogger } from "../lib/logger";
import { requestOrigin } from "../lib/request-origin";
import { getEffectiveSearchForcedKind } from "../lib/safe-mode";
import { logRequest } from "../services/logging/log_job";
import { resolveIntegration } from "../utils/integration";
import { wrap } from "./shared";

const TIMEOUT_MS = 30_000;
const UPSTREAM_PATH = "/fresh-vertical-feed/local/latest";

function freshFeedError(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function requireFreshFeedFlag(req: Request, res: Response, next: NextFunction) {
  if (!(req as RequestWithAuth<any, any, any>).acuc?.flags?.freshFeed) {
    return freshFeedError(
      res,
      403,
      "This endpoint is not enabled for this team.",
    );
  }
  next();
}

function eventCount(body: Buffer): number {
  try {
    const events = JSON.parse(body.toString()).events;
    return Array.isArray(events) ? events.length : 0;
  } catch {
    return 0;
  }
}

function freshFeedController(upstreamBase: string) {
  return async (req: Request, res: Response) => {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const zeroDataRetention =
      getEffectiveSearchForcedKind(authedReq.acuc?.flags, undefined) !== null;

    const started = Date.now();
    const jobId = uuidv7();
    const logger = rootLogger.child({
      module: "api/fresh-feed",
      jobId,
      teamId: authedReq.auth.team_id,
      zeroDataRetention,
    });

    const queryStart = req.originalUrl.indexOf("?");
    const target =
      UPSTREAM_PATH +
      (queryStart === -1 ? "" : req.originalUrl.slice(queryStart));

    await logRequest({
      id: jobId,
      kind: "fresh_feed",
      api_version: "v2",
      external_request_id: externalRequestId(authedReq),
      team_id: authedReq.auth.team_id,
      origin: requestOrigin({}, req),
      integration: resolveIntegration(undefined, req) ?? null,
      target_hint: target,
      zeroDataRetention,
      api_key_id: authedReq.acuc?.api_key_id ?? null,
    });

    try {
      const upstream = await fetch(upstreamBase + target, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (upstream.status !== 200 && upstream.status !== 400) {
        await upstream.body?.cancel();
        logger.error("Fresh feed upstream error", {
          status: upstream.status,
          seconds: (Date.now() - started) / 1000,
        });
        return freshFeedError(res, 502, "The request could not be completed.");
      }

      const body = Buffer.from(await upstream.arrayBuffer());
      const events = upstream.status === 200 ? eventCount(body) : 0;

      logger.info("Fresh feed request", {
        status: upstream.status,
        events,
        seconds: (Date.now() - started) / 1000,
      });

      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      return res.status(upstream.status).send(body);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        logger.error("Fresh feed timed out");
        return freshFeedError(res, 504, "The request timed out.");
      }
      logger.error("Fresh feed proxy error", { error });
      return freshFeedError(res, 502, "The request could not be completed.");
    }
  };
}

export function createFreshFeedRouter(upstreamUrl: string) {
  const router = express.Router();
  router.get(
    "/local/latest",
    requireFreshFeedFlag,
    compression(),
    wrap(freshFeedController(upstreamUrl.replace(/\/+$/, ""))),
  );
  return router;
}
