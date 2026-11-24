import { NextFunction, Request, Response } from "express";
// import { crawlStatusController } from "../../src/controllers/v1/crawl-status";
import {
  isAgentExtractModelValid,
  RequestWithAuth,
  RequestWithMaybeAuth,
  RequestWithMaybeACUC,
} from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
import { authenticateUser } from "../controllers/auth";
import { applyAgentAuthDiscoveryHeader } from "../lib/agent-auth-discovery";
import { createIdempotencyKey } from "../services/idempotency/create";
import { validateIdempotencyKey } from "../services/idempotency/validate";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { logger } from "../lib/logger";
import { logAuthDenied } from "../lib/auth-denied-log";
import {
  httpRequestDurationSeconds,
  getRoutePattern,
} from "../lib/http-metrics";
import { UNSUPPORTED_SITE_MESSAGE } from "../lib/strings";
import * as geoip from "geoip-country";
import { service, type BillingOperation } from "../service";
import type {} from "../lib/billing-state";
import { validate as isUuid } from "uuid";

import { config } from "../config";
import {
  ThirdPartyDataTermsRequiredError,
  ThirdPartyDataUnsupportedOptionError,
} from "../lib/exchange";
import { getExchangeAccessForRequestBody } from "../lib/exchange-request";
import { getScrapeZDR } from "../lib/zdr-helpers";
import { isLockdownZeroDataRetention } from "../lib/safe-mode";
import { agentInteropStatus } from "../lib/agent-interop";
import { inferIntegration } from "../lib/infer-integration";
import { resolveIntegration } from "../utils/integration";

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

      const auth = await authenticateUser(req, res, rateLimiterMode, {
        ...options,
        allowKeyless,
      });

      if (!auth.success) {
        if (!res.headersSent) {
          if (auth.status === 401 || auth.agentAuthDiscovery) {
            applyAgentAuthDiscoveryHeader(res);
          }
          if (auth.retryAfterSeconds) {
            res.setHeader("Retry-After", String(auth.retryAfterSeconds));
          }
          return res.status(auth.status).json({
            success: false,
            error: auth.error,
            ...(auth.keylessReason ? { reason: auth.keylessReason } : {}),
            ...(auth.retryAfterSeconds
              ? { retry_after_seconds: auth.retryAfterSeconds }
              : {}),
            ...(auth.signupUrl ? { signup_url: auth.signupUrl } : {}),
          });
        } else {
          return;
        }
      }

      const { team_id, org_id, chunk } = auth;
      const agentInterop = agentInteropStatus(req);
      // An agent run started by a hosted MCP call makes its own calls under
      // the interop secret, and says so in the interop block. Only a trusted
      // block may say it: the run itself was verified when it started.
      const hostedMcp =
        auth.hostedMcp ||
        (agentInterop === "trusted" &&
          (req.body as any)?.__agentInterop?.hostedMcp === true);

      req.auth = {
        team_id,
        org_id,
        agentInterop,
        ...(hostedMcp ? { hostedMcp: true } : {}),
      };
      req.acuc = chunk ?? undefined;
      req.caller = { teamId: team_id };
      next();
    })().catch(err => next(err));
  };
}

/**
 * Sets the body `integration` via resolveIntegration, then infers a still
 * missing one. An invalid header is ignored.
 */
export function inferIntegrationMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return next();
  }

  const resolved = resolveIntegration(body.integration, req);
  if (resolved !== undefined) {
    body.integration = resolved;
  } else if (config.INFER_INTEGRATION_ENABLED) {
    const inferred = inferIntegration({
      origin: req.get("origin"),
      referer: req.get("referer"),
      userAgent: req.get("user-agent"),
      bodyOrigin: body.origin,
    });
    if (inferred) body.integration = inferred;
  }
  next();
}

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  (async () => {
    if (req.headers["x-idempotency-key"]) {
      const isIdempotencyValid = await validateIdempotencyKey(req);
      if (!isIdempotencyValid) {
        if (!res.headersSent) {
          return res
            .status(409)
            .json({ success: false, error: "Idempotency key already used" });
        }
      }
      createIdempotencyKey(req);
    }
    next();
  })().catch(err => next(err));
}
export function blocklistMiddleware(
  req: RequestWithMaybeACUC<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  return blocklistGate(req, res, next, { exchange: false });
}

/**
 * Blocklist gate for single-URL scrape-shaped routes (scrape, crawl), where a
 * blocklisted URL still passes when the exchange engine can serve it, asks
 * for the provider's terms when unaccepted terms are all that stands in the
 * way, and names the request option that keeps a provider out. Unblocked
 * URLs never consult the Exchange here: engine selection decides for them,
 * identically on every route, and scrapes them normally when terms are
 * missing. v2 batch scrape runs the same check per URL in its controller;
 * map, search and monitors keep plain blocklist behavior.
 */
export function scrapeBlocklistMiddleware(
  req: RequestWithMaybeACUC<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  return blocklistGate(req, res, next, { exchange: true });
}

function blocklistGate(
  req: RequestWithMaybeACUC<any, any, any>,
  res: Response,
  next: NextFunction,
  options: { exchange: boolean },
) {
  (async () => {
    if (
      typeof req.body.url !== "string" ||
      !isUrlBlocked(req.body.url, req.acuc?.flags ?? null, {
        team_id: req.acuc?.team_id ?? null,
        org_id: req.acuc?.org_id ?? null,
        origin: typeof req.body.origin === "string" ? req.body.origin : null,
        zeroDataRetention:
          req.body.zeroDataRetention === true || req.body.lockdown === true,
        safeMode: req.body.safeMode,
      })
    ) {
      return next();
    }

    if (options.exchange) {
      // Safe Mode lockdown implies ZDR, which keeps the Exchange out.
      const zeroDataRetention =
        getScrapeZDR(req.acuc?.flags) === "forced" ||
        req.body?.zeroDataRetention === true ||
        isLockdownZeroDataRetention(req.acuc?.flags, req.body?.safeMode);
      const exchangeAccess = await getExchangeAccessForRequestBody({
        body: req.body,
        flags: req.acuc?.flags ?? null,
        url: req.body.url,
        blocked: true,
        zeroDataRetention,
        teamId: req.acuc?.team_id ?? null,
        orgId: req.acuc?.org_id ?? null,
      });

      if (exchangeAccess.allowed) {
        return next();
      }

      if (exchangeAccess.termsRequired && !res.headersSent) {
        return res
          .status(403)
          .json(
            new ThirdPartyDataTermsRequiredError(
              exchangeAccess.terms,
            ).response(),
          );
      }

      if (
        !exchangeAccess.termsRequired &&
        exchangeAccess.unsupportedOption !== undefined &&
        !res.headersSent
      ) {
        return res
          .status(400)
          .json(
            new ThirdPartyDataUnsupportedOptionError(
              exchangeAccess.unsupportedOption,
            ).response(),
          );
      }
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
