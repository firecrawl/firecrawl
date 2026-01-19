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
import {
  reserveCredits,
  releaseReservation,
} from "../services/billing/credit_reservation";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { logger } from "../lib/logger";
import { BLOCKLISTED_URL_MESSAGE } from "../lib/strings";
import { addDomainFrequencyJob } from "../services";
import * as geoip from "geoip-country";
import { isSelfHosted } from "../lib/deployment";
import { validate as isUuid } from "uuid";

import { config } from "../config";
import { supabase_service } from "../services/supabase";
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

      const { success, remainingCredits, chunk } = await checkTeamCredits(
        req.acuc ?? null,
        req.auth.team_id,
        minimum ?? 1,
      );
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
          // Still need to reserve the adjusted credits
          const creditsToReserve = remainingCredits;
          if (req.acuc?.api_key && creditsToReserve > 0) {
            const reservation = await reserveCredits(
              req.acuc.api_key,
              req.auth.team_id,
              creditsToReserve,
              req.acuc?.is_extract ?? false,
            );
            if (reservation) {
              req.creditReservation = {
                id: reservation.id,
                credits: reservation.credits,
              };
            }
          }
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

      // Reserve credits to prevent concurrent requests from exceeding limits
      // This atomically decrements the cached credit balance
      const creditsToReserve = minimum ?? 1;
      if (req.acuc?.api_key && creditsToReserve > 0) {
        const reservation = await reserveCredits(
          req.acuc.api_key,
          req.auth.team_id,
          creditsToReserve,
          req.acuc?.is_extract ?? false,
        );
        if (reservation) {
          req.creditReservation = {
            id: reservation.id,
            credits: reservation.credits,
          };
          logger.debug("Reserved credits for request", {
            reservationId: reservation.id,
            credits: creditsToReserve,
            teamId: req.auth.team_id,
          });
        } else {
          logger.warn("Failed to reserve credits, proceeding without reservation", {
            teamId: req.auth.team_id,
            credits: creditsToReserve,
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

      // Track domain frequency regardless of caching
      try {
        // Use the URL from the request body if available
        const urlToTrack = (req.body as any)?.url;
        if (urlToTrack) {
          // await addDomainFrequencyJob(urlToTrack);
        }
      } catch (error) {
        // Log error without meta.logger since it's not available in this context
        logger.warn("Failed to track domain frequency", { error });
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

      const { team_id, chunk } = auth;

      req.auth = { team_id };
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
        error: BLOCKLISTED_URL_MESSAGE,
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

/**
 * Middleware to release credit reservations when a request fails.
 * Should be added as an error handler middleware.
 */
export function creditReservationErrorHandler(
  err: Error,
  req: RequestWithAuth,
  res: Response,
  next: NextFunction,
) {
  // Release the reservation if one exists and the request failed
  if (req.creditReservation?.id) {
    releaseReservation(req.creditReservation.id).catch(releaseError => {
      logger.error("Failed to release credit reservation on error", {
        reservationId: req.creditReservation?.id,
        originalError: err.message,
        releaseError,
      });
    });
  }
  next(err);
}

/**
 * Middleware that sets up response listeners to release reservations
 * if the response indicates an error (4xx, 5xx status codes).
 * Call this early in the middleware chain, after authentication.
 */
export function creditReservationCleanupMiddleware(
  req: RequestWithAuth,
  res: Response,
  next: NextFunction,
) {
  // Listen for response finish to check if we need to release reservation
  res.on("finish", () => {
    // If response was an error and we have a reservation that wasn't used
    // Note: Successful requests should call billTeam which finalizes the reservation
    if (
      req.creditReservation?.id &&
      res.statusCode >= 400 &&
      res.statusCode < 600
    ) {
      releaseReservation(req.creditReservation.id).catch(error => {
        logger.error("Failed to release credit reservation on error response", {
          reservationId: req.creditReservation?.id,
          statusCode: res.statusCode,
          error,
        });
      });
    }
  });
  next();
}
