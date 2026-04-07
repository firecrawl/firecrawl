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
import { createIdempotencyKey } from "../services/idempotency/create";
import { validateIdempotencyKey } from "../services/idempotency/validate";
import { checkTeamCredits } from "../services/billing/credit_billing";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { logger } from "../lib/logger";
import {
  httpRequestDurationSeconds,
  getRoutePattern,
} from "../lib/http-metrics";
import { UNSUPPORTED_SITE_MESSAGE } from "../lib/strings";
import * as geoip from "geoip-country";
import { isSelfHosted } from "../lib/deployment";
import { validate as isUuid } from "uuid";

import { config } from "../config";
import { supabase_service } from "../services/supabase";
import {
  autumnService,
  isAutumnCheckEnabled,
} from "../services/autumn/autumn.service";

export function checkCreditsMiddleware(
  _minimum?: number,
): (req: RequestWithAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    let minimum = _minimum;
    (async () => {
      if (
        config.AGENT_INTEROP_SECRET &&
        req.body &&
        (req.body as any).__agentInterop &&
        (req.body as any).__agentInterop.auth &&
        (req.body as any).__agentInterop.auth === config.AGENT_INTEROP_SECRET &&
        (req.body as any).__agentInterop.shouldBill === false
      ) {
        return next();
      }

      // Agent-provisioned key enforcement: check sponsor status and 50-credit cap
      if (req.acuc?._agentSponsor) {
        const sponsor = req.acuc._agentSponsor;

        if (sponsor.status === "blocked") {
          return res.status(403).json({
            success: false,
            error: "This API key has been blocked by the account holder.",
          });
        }

        if (sponsor.status === "pending") {
          const deadline = new Date(sponsor.verification_deadline);
          if (deadline < new Date()) {
            return res.status(403).json({
              success: false,
              error: "sponsor_verification_expired",
              message:
                "Sponsor verification has expired. The account holder needs to log in to confirm.",
              login_url: "https://firecrawl.dev/signin",
            });
          }

          // Enforce 50-credit cap for unverified agent keys
          const UNVERIFIED_CREDIT_LIMIT = 50;
          if (req.acuc.adjusted_credits_used >= UNVERIFIED_CREDIT_LIMIT) {
            return res.status(402).json({
              success: false,
              error: "unverified_credit_limit_reached",
              message:
                "This agent key has used its 50 unverified credits. Ask the account holder to confirm the key to unlock full access.",
              credit_limit: UNVERIFIED_CREDIT_LIMIT,
              credits_used: req.acuc.adjusted_credits_used,
              sponsor_status: "pending",
              login_url: "https://firecrawl.dev/signin",
              upgrade_url: "https://firecrawl.dev/pricing",
            });
          }

          // Force index-only mode for all pre-confirmation agent requests
          (req as any).agentIndexOnly = true;
        }
        // If verified, fall through to normal credit check (key is now on real account)
      }

      if (!minimum && req.body) {
        minimum = Number(
          (req.body as any)?.limit ?? (req.body as any)?.urls?.length ?? 1,
        );
        if (isNaN(minimum) || !isFinite(minimum) || minimum <= 0) {
          minimum = undefined;
        }
      }

      if (req.path.startsWith("/agent")) {
        if (config.USE_DB_AUTHENTICATION) {
          const { data, error: freeRequestError } = await supabase_service.rpc(
            "get_agent_free_requests_left",
            {
              i_team_id: req.auth.team_id,
            },
          );

          if (freeRequestError) {
            logger.warn("Failed to get agent free requests left", {
              error: freeRequestError,
              teamId: req.auth.team_id,
            });
          } else {
            if (data?.[0]?.free_requests_left !== 0) {
              return next();
            }
          }
        }
      }

      const requestedCredits = minimum ?? 1;
      const useAutumnCheck = isAutumnCheckEnabled();

      const autumnProperties = {
        source: "checkCreditsMiddleware",
        path: req.path,
      };
      const [legacyCheck, autumnResult] = await Promise.all([
        checkTeamCredits(req.acuc ?? null, req.auth.team_id, requestedCredits),
        useAutumnCheck
          ? autumnService.checkCredits({
              teamId: req.auth.team_id,
              value: requestedCredits,
              properties: autumnProperties,
            })
          : null,
      ]);
      let { success, remainingCredits, chunk } = legacyCheck;

      if (autumnResult !== null) {
        success = autumnResult.allowed;
        remainingCredits = autumnResult.remaining;
      }

      if (chunk) {
        req.acuc = chunk;
      }
      req.account = { remainingCredits };
      if (!success) {
        if (
          !minimum &&
          req.body &&
          (req.body as any).limit !== undefined &&
          remainingCredits > 0
        ) {
          logger.warn("Adjusting limit to remaining credits", {
            teamId: req.auth.team_id,
            remainingCredits,
            request: req.body,
          });
          (req.body as any).limit = remainingCredits;
          return next();
        }

        const currencyName = req.acuc?.is_extract ? "tokens" : "credits";
        logger.error(
          `Insufficient ${currencyName}: ${JSON.stringify({ team_id: req.auth.team_id, minimum, remainingCredits })}`,
          {
            teamId: req.auth.team_id,
            minimum,
            remainingCredits,
            request: req.body,
            path: req.path,
          },
        );
        if (
          !res.headersSent &&
          req.auth.team_id !== "8c528896-7882-4587-a4b6-768b721b0b53"
        ) {
          return res.status(402).json({
            success: false,
            error:
              "Insufficient " +
              currencyName +
              " to perform this request. For more " +
              currencyName +
              ", you can upgrade your plan at " +
              (currencyName === "credits"
                ? "https://firecrawl.dev/pricing or try changing the request limit to a lower value"
                : "https://www.firecrawl.dev/extract#pricing") +
              ".",
          });
        }
      }
      next();
    })().catch(err => next(err));
  };
}

export function authMiddleware(
  rateLimiterMode: RateLimiterMode,
): (req: RequestWithMaybeAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    (async () => {
      let currentRateLimiterMode = rateLimiterMode;
      if (
        currentRateLimiterMode === RateLimiterMode.Extract &&
        isAgentExtractModelValid((req.body as any)?.agent?.model)
      ) {
        currentRateLimiterMode = RateLimiterMode.ExtractAgentPreview;
      }

      // if (currentRateLimiterMode === RateLimiterMode.Scrape && isAgentExtractModelValid((req.body as any)?.agent?.model)) {
      //   currentRateLimiterMode = RateLimiterMode.ScrapeAgentPreview;
      // }

      const auth = await authenticateUser(req, res, currentRateLimiterMode);

      if (!auth.success) {
        if (!res.headersSent) {
          return res
            .status(auth.status)
            .json({ success: false, error: auth.error });
        } else {
          return;
        }
      }

      const { team_id, org_id, chunk } = auth;

      req.auth = { team_id, org_id };
      req.acuc = chunk ?? undefined;
      if (chunk) {
        req.account = {
          remainingCredits: chunk.price_should_be_graceful
            ? chunk.remaining_credits + chunk.price_credits
            : chunk.remaining_credits,
        };
      }
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
  if (
    typeof req.body.url === "string" &&
    isUrlBlocked(req.body.url, req.acuc?.flags ?? null)
  ) {
    if (!res.headersSent) {
      return res.status(403).json({
        success: false,
        error: UNSUPPORTED_SITE_MESSAGE,
      });
    }
  }
  next();
}

export function countryCheck(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  if (req.acuc?.flags?.skipCountryCheck) {
    return next();
  }

  const couldBeRestricted =
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
      req.body.scrapeOptions?.extract?.agent ||
      req.path.startsWith("/v2/agent"));

  if (!couldBeRestricted) {
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
      error: isSelfHosted()
        ? "Use of headers, actions, and the FIRE-1 agent is not allowed by default in your country. Please check your server configuration."
        : "Use of headers, actions, and the FIRE-1 agent is not allowed by default in your country. Please contact us at help@firecrawl.com",
    });
  }

  next();
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
