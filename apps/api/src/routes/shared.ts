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
import { BLOCKLISTED_URL_MESSAGE } from "../lib/strings";
import { addDomainFrequencyJob } from "../services";
import * as geoip from "geoip-country";
import { isSelfHosted } from "../lib/deployment";

export function checkCreditsMiddleware(
  _minimum?: number,
): (req: RequestWithAuth, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    let minimum = _minimum;
    (async () => {
      if (!minimum && req.body) {
        minimum = Number(
          (req.body as any)?.limit ?? (req.body as any)?.urls?.length ?? 1,
        );
        if (isNaN(minimum) || !isFinite(minimum) || minimum <= 0) {
          minimum = undefined;
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
      req.body.scrapeOptions?.extract?.agent);

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

  const restricted = process.env.RESTRICTED_COUNTRIES?.split(",") ?? [];
  if (restricted.includes(country.country)) {
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
