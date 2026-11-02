import { bountyBlocklistMiddleware } from "./exchange-blocklist";
import { providerScrapeController } from "../controllers/v2/scrape-alexandria";
import { billingCountryForTeam } from "../lib/billing-country";
import { orgIdFromAcuc } from "../lib/team-org";
import {
  acceptProviderTerms,
  acceptTermsSchema,
} from "../services/alexandria/terms";
import express, { Request, Response } from "express";
import { Agent, fetch, type Response as UpstreamResponse } from "undici";
import type { Logger } from "winston";
import { config } from "../config";
import { recordAlexandriaActivity } from "../lib/alexandria-activity";
import { teamRecommendationSignals } from "../services/alexandria/recommendation-signals";
import { logger as rootLogger } from "../lib/logger";
import type { RequestWithAuth } from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
import { authMiddleware, wrap } from "./shared";

const DISCOVER_TIMEOUT_MS = 10_000;
const RETRIEVE_TIMEOUT_MS = 50_000;
const ANALYTICS_TIMEOUT_MS = 20_000;
const APPLICATIONS_TIMEOUT_MS = 15_000;
const CLAIMS_TIMEOUT_MS = 20_000;
const SUPPLY_TIMEOUT_MS = 30_000;
const INGEST_TIMEOUT_MS = 50_000;

const FORWARDED_REQUEST_HEADERS = ["accept", "x-request-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-request-id"];
const FORWARDED_PATH_ROOTS = new Set([
  "analytics",
  "applications",
  "claims",
  "connectors",
  "discover",
  "enrichment",
  "ingest",
  "platform",
  "provider-skills",
  "provider-terms",
  "publisher",
  "rates",
  "records",
  "skills",
  "supply",
  "team-skills",
]);

function dispatcherFor(timeout: number) {
  return new Agent({
    connectTimeout: timeout,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
}

function exchangeError(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function upstreamBase(): string | null {
  if (!config.FIRE_EXCHANGE_URL) return null;
  return config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
}

function forwardedRequestHeaders(req: Request): Record<string, string> {
  return Object.fromEntries(
    FORWARDED_REQUEST_HEADERS.flatMap(h => {
      const value = req.headers[h];
      return typeof value === "string" ? [[h, value]] : [];
    }),
  );
}

function sendUpstream(res: Response, upstream: UpstreamResponse, text: string) {
  for (const h of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(h);
    if (value) res.setHeader(h, value);
  }

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (body === null || typeof body === "string") {
    return res.status(upstream.status).send(body ?? "");
  }
  return res.status(upstream.status).json(body);
}

function upstreamFailure(res: Response, logger: Logger, error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    logger.error("Exchange proxy timed out");
    return exchangeError(res, 504, "The request timed out.");
  }
  logger.error("Exchange proxy error", { error });
  return exchangeError(res, 502, "The request could not be completed.");
}

// Rebuilds the upstream path from validated, re-encoded segments so it always
// names the route that authorized the request.
function upstreamPath(req: Request): string | null {
  const segments = req.path.split("/").slice(1);
  if (segments.length > 1 && segments.at(-1) === "") segments.pop();

  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!value || value === "." || value === ".." || /[/\\]/.test(value)) {
      return null;
    }
    decoded.push(value);
  }
  if (!FORWARDED_PATH_ROOTS.has(decoded[0])) return null;

  const queryStart = req.originalUrl.indexOf("?");
  const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
  return "/v1/" + decoded.map(encodeURIComponent).join("/") + query;
}

function exchangeProxy(
  timeout: number,
  options: {
    requiresRetrieveFlag?: boolean;
    opensFeedbackWindow?: boolean;
  } = {},
) {
  const requiresRetrieveFlag = options.requiresRetrieveFlag !== false;
  const dispatcher = dispatcherFor(timeout);

  return async function controller(req: Request, res: Response) {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const logger = rootLogger.child({
      module: "api/exchange",
      method: req.method,
      path: req.path,
      teamId: authedReq.auth.team_id,
    });

    const base = upstreamBase();
    if (!base) {
      return exchangeError(res, 503, "This endpoint is not available.");
    }

    const path = upstreamPath(req);
    if (path === null) {
      return exchangeError(res, 400, "Invalid request path.");
    }

    if (requiresRetrieveFlag && !authedReq.acuc?.flags?.exchangeRetrieve) {
      return exchangeError(
        res,
        403,
        "This endpoint is not enabled for this team.",
      );
    }

    const hasBody = req.method !== "GET";
    const billingCountry = await billingCountryForTeam(authedReq.auth.team_id);

    try {
      const upstream = await fetch(base + path, {
        method: req.method,
        headers: {
          ...forwardedRequestHeaders(req),
          ...(hasBody ? { "content-type": "application/json" } : {}),
          "x-exchange-team-id": authedReq.auth.team_id,
          ...(req.ip ? { "x-exchange-client-ip": req.ip } : {}),
          ...(billingCountry
            ? { "x-exchange-billing-country": billingCountry }
            : {}),
          // Built here, never forwarded from the caller: the connectors whitelist is this flag.
          ...(authedReq.acuc?.flags?.exchangeRetrieve
            ? { "x-exchange-connectors": "true" }
            : {}),
        },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeout),
        dispatcher,
      });

      const text = await upstream.text();
      // Awaited so feedback sent right after this response sees the window.
      if (options.opensFeedbackWindow && upstream.ok) {
        await recordAlexandriaActivity(authedReq.auth.team_id);
      }
      return sendUpstream(res, upstream, text);
    } catch (error: unknown) {
      return upstreamFailure(res, logger, error);
    }
  };
}

const recommendationsDispatcher = dispatcherFor(DISCOVER_TIMEOUT_MS);

// The team's own usage signals go to the Exchange, which owns the ranking. The team is always the
// authenticated one, and search queries are read only when the caller asks for them.
async function recommendationsController(req: Request, res: Response) {
  const authedReq = req as RequestWithAuth<any, any, any>;
  const teamId = authedReq.auth.team_id;
  const logger = rootLogger.child({
    module: "api/exchange",
    method: req.method,
    path: req.path,
    teamId,
  });

  const base = upstreamBase();
  if (!base) {
    return exchangeError(res, 503, "This endpoint is not available.");
  }

  const signals = await teamRecommendationSignals(teamId, {
    searches: req.query.searches === "true",
  });

  try {
    const upstream = await fetch(base + "/v1/recommendations", {
      method: "POST",
      headers: {
        ...forwardedRequestHeaders(req),
        "content-type": "application/json",
        "x-exchange-team-id": teamId,
      },
      body: JSON.stringify(signals),
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      dispatcher: recommendationsDispatcher,
    });
    return sendUpstream(res, upstream, await upstream.text());
  } catch (error: unknown) {
    return upstreamFailure(res, logger, error);
  }
}

async function providerTermsAcceptController(req: Request, res: Response) {
  const authedReq = req as RequestWithAuth<any, any, any>;
  const orgId = orgIdFromAcuc(authedReq.acuc);
  if (orgId === null) {
    return exchangeError(
      res,
      403,
      "This endpoint is not enabled for this team.",
    );
  }
  const body = acceptTermsSchema.safeParse(req.body);
  if (!body.success) {
    return exchangeError(
      res,
      400,
      "Send { provider, version, digest, confirmed: true } for one provider.",
    );
  }
  const response = await acceptProviderTerms({
    teamId: authedReq.auth.team_id,
    orgId,
    apiKeyId:
      authedReq.acuc?.api_key_id_text ??
      (authedReq.acuc?.api_key_id == null
        ? null
        : String(authedReq.acuc.api_key_id)),
    body: body.data,
    clientIp: authedReq.ip,
    billingCountry: await billingCountryForTeam(authedReq.auth.team_id),
  });
  return res.status(response.status).json(response.body);
}

export const exchangeRouter = express.Router();

// Discover is a flat 10,000/min catalogue read. Retrieve and records/fetch take
// the plan's scrape-equivalent budget (base 10/min, multiplier scaled).
// Dashboard and publisher routes below stay on the flat Labs limit.
exchangeRouter.get(
  "/discover{/*path}",
  authMiddleware(RateLimiterMode.ExchangeDiscover, {
    allowAgentManagedKey: true,
  }),
  wrap(
    exchangeProxy(DISCOVER_TIMEOUT_MS, {
      requiresRetrieveFlag: false,
      opensFeedbackWindow: true,
    }),
  ),
);

// Providers suggested from the team's own usage. A read like discover, but each call aggregates
// the team's recent activity, so it stays on the flat Labs limit rather than discover's.
exchangeRouter.get(
  "/recommendations",
  authMiddleware(RateLimiterMode.Labs),
  wrap(recommendationsController),
);

// These read-only discovery routes remain authenticated; they do not execute paid tools.
exchangeRouter.post(
  "/skills/resolve",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(DISCOVER_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/skills/:id/SKILL.md",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(DISCOVER_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

// Provider agreements the web app offers for acceptance; a catalogue read, never an acceptance.
exchangeRouter.get(
  "/provider-terms{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(DISCOVER_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/provider-terms/accept",
  authMiddleware(RateLimiterMode.Labs),
  wrap(providerTermsAcceptController),
);

exchangeRouter.post(
  "/provider-terms/events",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(DISCOVER_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/enrichment/preferences",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
exchangeRouter.put(
  "/enrichment/preferences",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
exchangeRouter.post(
  "/enrichment/plan",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

// A team's own MCP connectors (Alexandria connectors): the catalogue, and adding, listing,
// syncing, changing and removing its connections. Behind the exchangeRetrieve flag, the same
// flag that tells Exchange the team may use them. Connecting and syncing reach the team's server
// and list its tools before answering, so writes get the longer timeout.
exchangeRouter.get(
  "/connectors{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS)),
);
exchangeRouter.post(
  "/connectors{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(RETRIEVE_TIMEOUT_MS)),
);
exchangeRouter.patch(
  "/connectors{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(RETRIEVE_TIMEOUT_MS)),
);
exchangeRouter.delete(
  "/connectors{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS)),
);

// Every team may list, read and write its own skills; Exchange scopes them by the stamped team.
exchangeRouter.get(
  "/team-skills{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
exchangeRouter.post(
  "/team-skills{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
exchangeRouter.patch(
  "/team-skills{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
exchangeRouter.delete(
  "/team-skills{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

// Provider-authored skills. Every team may list and read them, and turn a plugin
// or one skill on or off. Exchange scopes that toggle by the stamped team.
exchangeRouter.get(
  "/provider-skills{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
exchangeRouter.patch(
  "/provider-skills{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/retrieve",
  authMiddleware(RateLimiterMode.Exchange, { allowAgentManagedKey: true }),
  wrap((req, res) =>
    providerScrapeController(req as RequestWithAuth<any, any, any>, res, true),
  ),
);

exchangeRouter.get(
  "/analytics{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS)),
);

exchangeRouter.get(
  "/platform{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/platform{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.put(
  "/platform/capacity/{*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: true })),
);

exchangeRouter.delete(
  "/platform/capacity/buckets/{*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: true })),
);

exchangeRouter.post(
  "/rates/lookup",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/rates/lookup",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/publisher/supply/key",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/publisher{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties",
  authMiddleware(RateLimiterMode.Labs, { allowAgentManagedKey: true }),
  bountyBlocklistMiddleware,
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.put(
  "/publisher/bounties/:id",
  authMiddleware(RateLimiterMode.Labs),
  bountyBlocklistMiddleware,
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.delete(
  "/publisher/bounties/:id",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties/:id/claim",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties/:id/submit",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties/:id/skill",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/applications",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(APPLICATIONS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/applications/:id/withdraw",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(APPLICATIONS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/claims",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/claims",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/claims/:id/release",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/claims/:id/verify",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/supply/key",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.put(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.delete(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/records/fetch",
  authMiddleware(RateLimiterMode.Exchange),
  wrap(exchangeProxy(RETRIEVE_TIMEOUT_MS)),
);

exchangeRouter.get(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.patch(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.delete(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
