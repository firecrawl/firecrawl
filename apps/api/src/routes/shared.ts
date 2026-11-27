import { NextFunction, Request, Response } from "express";
import {
  type AgentInteropStatus,
  AuthCreditUsageChunk,
  RequestWithAuth,
  RequestWithMaybeAuth,
  RequestWithMaybeACUC,
} from "../controllers/v2/types";
import { RateLimiterMode } from "../types";
import { requestContext } from "../lib/request-context";
import { logger } from "../lib/logger";
import {
  httpRequestDurationSeconds,
  getRoutePattern,
} from "../lib/http-metrics";
import { UNSUPPORTED_SITE_MESSAGE } from "../lib/strings";
import * as geoip from "geoip-country";
import { claimIdempotencyKey } from "../lib/idempotency";
import {
  service,
  type AuthRoute,
  type BillingOperation,
  type Caller,
} from "../service";
import {
  rejectRequest,
  requestKindForPath,
  sendRefusal,
} from "../service/http";
import type {} from "../lib/billing-state";
import { validate as isUuid } from "uuid";

import { config } from "../config";

function billingOperationForPath(path: string): BillingOperation {
  switch (path.replace(/^\/v\d+/, "")) {
    case "/scrape":
      return "scrape";
    case "/parse":
      return "parse";
    case "/search":
      return "search";
    case "/map":
      return "map";
    case "/crawl":
    case "/crawl/params-preview":
      return "crawl";
    case "/batch/scrape":
      return "batchScrape";
    default:
      return "other";
  }
}

export function checkCreditsMiddleware(
  _minimum?: number,
  featureId?: string,
  { mcpCredits = false }: { mcpCredits?: boolean } = {},
): (req: RequestWithAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    (async () => {
      let requestedUnits = _minimum;
      if (requestedUnits === undefined && req.body) {
        const derived = Number(
          (req.body as any)?.limit ?? (req.body as any)?.urls?.length ?? 1,
        );
        if (Number.isFinite(derived) && derived > 0) {
          requestedUnits = derived;
        }
      }

      const authz = await service.modules.billing.authorize({
        caller: req.caller ?? { teamId: req.auth.team_id },
        operation: billingOperationForPath(req.path),
        stage: "preflight",
        requestedUnits,
        state: {
          req,
          minimum: _minimum,
          featureId,
          mcpCredits,
        },
      });

      if (!authz.ok) {
        if (!res.headersSent) {
          if (authz.refusal.headers) {
            for (const [name, value] of Object.entries(authz.refusal.headers)) {
              res.setHeader(name, value);
            }
          }
          return res.status(authz.refusal.status).json(authz.refusal.body);
        }
        return;
      }

      req.account = { remainingCredits: authz.maxUnits ?? Infinity };
      if (
        authz.clampedLimit !== undefined &&
        req.body &&
        typeof req.body === "object"
      ) {
        (req.body as any).limit = authz.clampedLimit;
      }
      next();
    })().catch(err => next(err));
  };
}

type LegacyAuthRoute = AuthRoute & {
  allowKeyless?: boolean;
  allowAgentManagedKey?: boolean;
  hostedMcpRateLimit?: boolean;
};

type LegacyCallerFields = {
  orgId?: string | null;
  chunk?: AuthCreditUsageChunk | null;
  agentInterop?: AgentInteropStatus;
  hostedMcp?: boolean;
};

export function authMiddleware(
  rateLimiterMode: RateLimiterMode,
  options: {
    allowKeyless?: boolean | ((req: RequestWithMaybeAuth) => boolean);
    allowAgentManagedKey?: boolean;
    hostedMcpRateLimit?: boolean;
  } = {},
): (req: RequestWithMaybeAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    (async () => {
      const allowKeyless =
        typeof options.allowKeyless === "function"
          ? options.allowKeyless(req)
          : options.allowKeyless;

      const route: LegacyAuthRoute = {
        kind: rateLimiterMode,
        ...(allowKeyless !== undefined ? { allowKeyless } : {}),
        ...(options.allowAgentManagedKey !== undefined
          ? { allowAgentManagedKey: options.allowAgentManagedKey }
          : {}),
        ...(options.hostedMcpRateLimit !== undefined
          ? { hostedMcpRateLimit: options.hostedMcpRateLimit }
          : {}),
      };

      const result = await service.modules.auth.authenticate(req, route);

      if (!result.ok) {
        const requestKind = requestKindForPath(req.path);
        if (requestKind) {
          rejectRequest(req, res, requestKind, result.refusal);
        } else {
          sendRefusal(res, result.refusal);
        }
        return;
      }

      if (!res.headersSent) {
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          res.setHeader(name, value);
        }
      }

      const caller = result.caller as Caller & LegacyCallerFields;
      req.auth = {
        team_id: caller.teamId,
        org_id: caller.orgId ?? null,
        ...(caller.agentInterop !== undefined
          ? { agentInterop: caller.agentInterop }
          : {}),
        ...(caller.hostedMcp === true ? { hostedMcp: true } : {}),
      };
      req.acuc = caller.chunk ?? undefined;
      req.caller = result.caller;
      next();
    })().catch(err => next(err));
  };
}

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  (async () => {
    const rawHeader = req.headers["x-idempotency-key"];
    if (rawHeader) {
      const teamId =
        req.ctx?.teamId ??
        req.caller?.teamId ??
        (req as RequestWithMaybeAuth).auth?.team_id ??
        "bypass";
      const claimed = await claimIdempotencyKey(rawHeader, teamId);
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

export function blocklistMiddleware(
  req: RequestWithMaybeACUC<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  (async () => {
    if (typeof req.body?.url !== "string") {
      return next();
    }
    const flags = (req.acuc?.flags ?? null) as Record<string, unknown> | null;
    const forcedZdr =
      flags?.scrapeZDR === "forced" ||
      flags?.forceZDR === true ||
      flags?.allowZDR === "forced";
    const safeModeConfig =
      flags?.safeModeConfig && typeof flags.safeModeConfig === "object"
        ? (flags.safeModeConfig as Record<string, unknown>)
        : undefined;
    const safeModeBypassed =
      req.body.safeMode === false &&
      safeModeConfig?.allowBypassSafeMode === true;
    const safeModeLockdown =
      flags?.safeMode === true &&
      !safeModeBypassed &&
      safeModeConfig?.lockdown === true;
    const blockCtx = requestContext({
      teamId: req.ctx?.teamId ?? req.acuc?.team_id ?? "",
      zeroDataRetention:
        req.ctx?.zeroDataRetention === true ||
        forcedZdr ||
        safeModeLockdown ||
        req.body.zeroDataRetention === true ||
        req.body.lockdown === true,
      flags: req.acuc?.flags ?? null,
      orgId: req.ctx?.orgId ?? req.acuc?.org_id ?? null,
    });
    if (
      !service.modules.blocklist.isBlocked(req.body.url, blockCtx, {
        origin: typeof req.body.origin === "string" ? req.body.origin : null,
      })
    ) {
      return next();
    }
    if (!res.headersSent) {
      return res.status(403).json({
        success: false,
        error: UNSUPPORTED_SITE_MESSAGE,
      });
    }
    next();
  })().catch(err => next(err));
}

export function countryCheck(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  if (req.acuc?.flags?.skipCountryCheck) {
    return next();
  }

  if (!req.ip) {
    logger.warn("IP address not found, unable to check country");
    return next();
  }

  const country = geoip.lookup(req.ip);
  if (!country || !country.country) {
    logger.warn("IP address country data not found", { ip: req.ip });
    return next();
  }

  if (config.RESTRICTED_COUNTRIES?.includes(country.country)) {
    logger.warn("Denied access to restricted country", {
      ip: req.ip,
      country: country.country,
      teamId: req.auth.team_id,
    });
    return res.status(403).json({
      success: false,
      error: `Use of headers, actions, the agent, and browser/interact sessions is not allowed by default in your country. ${service.modules.messages.restrictedCountryContact()}`,
    });
  }

  next();
}

export function restrictedOptionsCountryCheck(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  const usesRestrictedOptions =
    req.body &&
    (req.body.actions ||
      (req.body.headers &&
        typeof req.body.headers === "object" &&
        Object.keys(req.body.headers).length > 0) ||
      req.body.agent ||
      req.body.jsonOptions?.agent ||
      req.body.extract?.agent ||
      req.body.scrapeOptions?.actions ||
      (req.body.scrapeOptions?.headers &&
        typeof req.body.scrapeOptions.headers === "object" &&
        Object.keys(req.body.scrapeOptions.headers).length > 0) ||
      req.body.scrapeOptions?.agent ||
      req.body.scrapeOptions?.jsonOptions?.agent ||
      req.body.scrapeOptions?.extract?.agent);

  if (!usesRestrictedOptions) {
    return next();
  }

  countryCheck(req, res, next);
}

export function isValidJobId(jobId: string | undefined): jobId is string {
  return typeof jobId === "string" && isUuid(jobId);
}

export function validateJobIdParam(
  req: Request<{ jobId?: string }>,
  res: Response,
  next: NextFunction,
) {
  if (!isValidJobId(req.params.jobId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid job ID format. Job ID must be a valid UUID.",
    });
  }

  next();
}

export function requestTimingMiddleware(version: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = new Date().getTime();

    // Attach timing data to request
    (req as any).requestTiming = {
      startTime,
      version,
    };

    // Override res.json to log timing when response is sent
    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
      const requestTime = new Date().getTime() - startTime;

      const durationSeconds = requestTime / 1000;
      const route = getRoutePattern(req);
      const status = String(res.statusCode);

      httpRequestDurationSeconds
        .labels(version, req.method, route, status)
        .observe(durationSeconds);

      // Only log for successful responses to avoid duplicate error logs
      if (body?.success !== false) {
        logger.info(`${version} request completed`, {
          version,
          path: req.path,
          method: req.method,
          startTime,
          requestTime,
          statusCode: res.statusCode,
        });
      }

      return originalJson(body);
    };

    next();
  };
}

export function wrap(
  controller: (req: Request, res: Response) => Promise<any>,
): (req: Request, res: Response, next: NextFunction) => any {
  return (req, res, next) => {
    controller(req, res).catch(err => next(err));
  };
}
