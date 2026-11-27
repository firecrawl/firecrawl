import type { NextFunction, Request, Response } from "express";
import type {
  AuthCreditUsageChunk,
  RequestWithAuth,
  RequestWithMaybeAuth,
  RequestWithMaybeACUC,
} from "../controllers/v2/types";
import type { AgentInteropStatus } from "../controllers/v2/types";
import type { RateLimiterMode } from "../types";
import { requestContext } from "../lib/request-context";
import { logger } from "../lib/logger";
import {
  httpRequestDurationSeconds,
  getRoutePattern,
} from "../lib/http-metrics";
import { z } from "zod";
import { UNSUPPORTED_SITE_MESSAGE } from "../lib/strings";
import { lookup as lookupGeoIp } from "geoip-country";
import { claimIdempotencyKey } from "../lib/idempotency";
import { service } from "../service";
import type { AuthRoute, BillingOperation, Caller } from "../service";
import {
  rejectRequest,
  requestKindForPath,
  sendRefusal,
} from "../service/http";
import type {} from "../lib/billing-state";
import { validate as isUuid } from "uuid";

import { config } from "../config";

declare global {
  namespace Express {
    interface Request {
      requestTiming?: {
        startTime?: number;
        version?: string;
      };
    }
  }
}

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

const creditPreflightBodySchema = z.object({
  limit: z.unknown().optional(),
  urls: z.unknown().optional(),
});

const authTeamIdSchema = z.object({
  team_id: z.string(),
});

const blocklistBodySchema = z.object({
  url: z.string(),
  safeMode: z.unknown().optional(),
  zeroDataRetention: z.unknown().optional(),
  lockdown: z.unknown().optional(),
  origin: z.unknown().optional(),
});

const safeModeConfigSchema = z.object({
  allowBypassSafeMode: z.unknown().optional(),
  lockdown: z.unknown().optional(),
});

const blocklistFlagsSchema = z.object({
  scrapeZDR: z.unknown().optional(),
  forceZDR: z.unknown().optional(),
  allowZDR: z.unknown().optional(),
  safeMode: z.unknown().optional(),
  safeModeConfig: z.unknown().optional(),
});

const nonEmptyObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(value => Object.keys(value).length > 0);

const agentOptionSchema = z.object({
  agent: z.unknown(),
});

const restrictedOptionsBodySchema = z.object({
  actions: z.unknown().optional(),
  headers: z.unknown().optional(),
  agent: z.unknown().optional(),
  jsonOptions: z.unknown().optional(),
  extract: z.unknown().optional(),
  scrapeOptions: z.unknown().optional(),
});

const failureResponseBodySchema = z.object({
  success: z.literal(false),
});

export function checkCreditsMiddleware(
  _minimum?: number,
  featureId?: string,
  { mcpCredits = false }: { mcpCredits?: boolean } = {},
): (req: RequestWithAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    (async () => {
      let requestedUnits = _minimum;
      const rawBody: unknown = req.body;
      if (requestedUnits === undefined && rawBody) {
        const parsedBody = creditPreflightBodySchema.safeParse(rawBody);
        const body = parsedBody.success ? parsedBody.data : undefined;
        const urls = body?.urls;
        const derived = Number(
          body?.limit ?? (Array.isArray(urls) ? urls.length : 1),
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
        typeof rawBody === "object" &&
        rawBody !== null &&
        !Array.isArray(rawBody)
      ) {
        Object.assign(rawBody, { limit: authz.clampedLimit });
      }
      next();
    })().catch((error: unknown) => next(error));
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
      };
      if (allowKeyless !== undefined) {
        route.allowKeyless = allowKeyless;
      }
      if (options.allowAgentManagedKey !== undefined) {
        route.allowAgentManagedKey = options.allowAgentManagedKey;
      }
      if (options.hostedMcpRateLimit !== undefined) {
        route.hostedMcpRateLimit = options.hostedMcpRateLimit;
      }

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
      const auth: NonNullable<RequestWithMaybeAuth["auth"]> = {
        team_id: caller.teamId,
        org_id: caller.orgId ?? null,
      };
      if (caller.agentInterop !== undefined) {
        auth.agentInterop = caller.agentInterop;
      }
      if (caller.hostedMcp === true) {
        auth.hostedMcp = true;
      }
      req.auth = auth;
      req.acuc = caller.chunk ?? undefined;
      req.caller = result.caller;
      next();
    })().catch((error: unknown) => next(error));
  };
}

function readAuthTeamId(req: Request): string | undefined {
  if (!("auth" in req)) {
    return undefined;
  }
  const parsed = authTeamIdSchema.safeParse(req.auth);
  return parsed.success ? parsed.data.team_id : undefined;
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
        readAuthTeamId(req) ??
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
  })().catch((error: unknown) => next(error));
}

export function blocklistMiddleware(
  req: RequestWithMaybeACUC<Request["params"], unknown, unknown>,
  res: Response,
  next: NextFunction,
) {
  (async () => {
    const parsedBody = blocklistBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return next();
    }
    const body = parsedBody.data;
    const parsedFlags = blocklistFlagsSchema.safeParse(req.acuc?.flags);
    const flags = parsedFlags.success ? parsedFlags.data : null;
    const forcedZdr =
      flags?.scrapeZDR === "forced" ||
      flags?.forceZDR === true ||
      flags?.allowZDR === "forced";
    const parsedSafeModeConfig = safeModeConfigSchema.safeParse(
      flags?.safeModeConfig,
    );
    const safeModeConfig = parsedSafeModeConfig.success
      ? parsedSafeModeConfig.data
      : undefined;
    const safeModeBypassed =
      body.safeMode === false && safeModeConfig?.allowBypassSafeMode === true;
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
        body.zeroDataRetention === true ||
        body.lockdown === true,
      flags: req.acuc?.flags ?? null,
      orgId: req.ctx?.orgId ?? req.acuc?.org_id ?? null,
    });
    if (
      !service.modules.blocklist.isBlocked(body.url, blockCtx, {
        origin: typeof body.origin === "string" ? body.origin : null,
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
  })().catch((error: unknown) => next(error));
}

export function countryCheck(
  req: RequestWithAuth<Request["params"], unknown, unknown>,
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

  const country = lookupGeoIp(req.ip);
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

function hasNonEmptyObject(value: unknown): boolean {
  return nonEmptyObjectSchema.safeParse(value).success;
}

function hasAgentOption(value: unknown): boolean {
  const parsed = agentOptionSchema.safeParse(value);
  return parsed.success && Boolean(parsed.data.agent);
}

function hasRestrictedFields(
  fields: z.infer<typeof restrictedOptionsBodySchema>,
): boolean {
  return Boolean(
    fields.actions ||
    hasNonEmptyObject(fields.headers) ||
    fields.agent ||
    hasAgentOption(fields.jsonOptions) ||
    hasAgentOption(fields.extract),
  );
}

function hasRestrictedBodyOptions(body: unknown): boolean {
  const parsedBody = restrictedOptionsBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return false;
  }
  if (hasRestrictedFields(parsedBody.data)) {
    return true;
  }
  const parsedScrapeOptions = restrictedOptionsBodySchema.safeParse(
    parsedBody.data.scrapeOptions,
  );
  return (
    parsedScrapeOptions.success && hasRestrictedFields(parsedScrapeOptions.data)
  );
}

export function restrictedOptionsCountryCheck(
  req: RequestWithAuth<Request["params"], unknown, unknown>,
  res: Response,
  next: NextFunction,
) {
  if (!hasRestrictedBodyOptions(req.body)) {
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
    req.requestTiming = {
      startTime,
      version,
    };

    // Override res.json to log timing when response is sent
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      const requestTime = new Date().getTime() - startTime;

      const durationSeconds = requestTime / 1000;
      const route = getRoutePattern(req);
      const status = String(res.statusCode);

      httpRequestDurationSeconds
        .labels(version, req.method, route, status)
        .observe(durationSeconds);

      // Only log for successful responses to avoid duplicate error logs
      if (!failureResponseBodySchema.safeParse(body).success) {
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

export function wrap<
  Req extends Request = Request,
  Res extends Response = Response,
  Ret = Response | void,
>(
  controller: (req: Req, res: Res) => Promise<Ret>,
): (req: Req, res: Res, next: NextFunction) => void {
  return (req, res, next) => {
    controller(req, res).catch((error: unknown) => next(error));
  };
}
