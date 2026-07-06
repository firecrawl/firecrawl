import { Response } from "express";
import { config } from "../../config";
import {
  RequestWithAuth,
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
} from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import {
  KEYLESS_CREDITS_MESSAGE,
  adjustKeylessCredits,
  logKeylessCreditUsage,
  reserveKeylessCredits,
} from "../../lib/keyless";
import { v7 as uuidv7 } from "uuid";
import { logSearch, logRequest } from "../../services/logging/log_job";
import { logger as _logger } from "../../lib/logger";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { z } from "zod";
import { CategoryOption } from "../../lib/search-query-builder";
import {
  applyZdrScope,
  captureExceptionWithZdrCheck,
} from "../../services/sentry";
import { executeSearch } from "../../search/execute";
import type { BillingMetadata } from "../../services/billing/types";
import { getSearchForcedKind, getSearchZDR } from "../../lib/zdr-helpers";
import { projectSearchTotalCredits } from "../../lib/keyless-credit-projection";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";

export async function searchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
) {
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const jobId = uuidv7();
  const searchZDRMode = getSearchZDR(req.acuc?.flags);
  const teamForcedKind = getSearchForcedKind(req.acuc?.flags);
  let logger = _logger.child({
    jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "searchController",
    zeroDataRetention: teamForcedKind !== null,
    teamForcedKind,
  });

  const middlewareTime = controllerStartTime - middlewareStartTime;
  const isSearchPreview =
    config.SEARCH_PREVIEW_TOKEN !== undefined &&
    config.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  let zeroDataRetention = teamForcedKind !== null;
  let reservedKeylessCredits = 0;
  let reconciledKeylessCredits = false;

  try {
    req.body = searchRequestSchema.parse(req.body);

    if (
      req.body.__agentInterop &&
      config.AGENT_INTEROP_SECRET &&
      req.body.__agentInterop.auth !== config.AGENT_INTEROP_SECRET
    ) {
      return res.status(403).json({
        success: false,
        error: "Invalid agent interop.",
      });
    } else if (req.body.__agentInterop && !config.AGENT_INTEROP_SECRET) {
      return res.status(403).json({
        success: false,
        error: "Agent interop is not enabled.",
      });
    }

    const shouldBill = req.body.__agentInterop?.shouldBill ?? true;
    const agentRequestId = req.body.__agentInterop?.requestId ?? null;
    const billing: BillingMetadata = req.body.__agentInterop
      ? { endpoint: "agent" as const, jobId }
      : { endpoint: "search" as const, jobId };

    logger = logger.child({
      version: "v2",
      query: req.body.query,
      origin: req.body.origin,
    });

    // Inject the team-forced enterprise mode so downstream billing,
    // upstream routing, and ZDR cleanup all see it.
    if (teamForcedKind) {
      const existing = req.body.enterprise ?? [];
      if (!existing.includes(teamForcedKind)) {
        req.body.enterprise = [...existing, teamForcedKind];
      }
    }

    const isZDR = req.body.enterprise?.includes("zdr");
    const isAnon = req.body.enterprise?.includes("anon");
    const isZDROrAnon = isZDR || isAnon;
    zeroDataRetention = isZDROrAnon ?? false;
    logger = logger.child({ zeroDataRetention });
    applyZdrScope(zeroDataRetention);

    // Verify the team has searchZDR enabled before allowing enterprise ZDR/anon
    if (isZDROrAnon && !teamForcedKind) {
      if (searchZDRMode !== "allowed") {
        return res.status(403).json({
          success: false,
          error:
            "Zero Data Retention (ZDR) search is not enabled for your team. Contact support@firecrawl.com to enable this feature.",
        });
      }
    }

    if (!agentRequestId) {
      await logRequest({
        id: jobId,
        kind: "search",
        api_version: "v2",
        team_id: req.auth.team_id,
        origin: req.body.origin ?? "api",
        integration: req.body.integration,
        target_hint: req.body.query,
        zeroDataRetention,
        api_key_id: req.acuc?.api_key_id ?? null,
      });
    }

    const projectedKeylessCredits =
      !isSearchPreview && shouldBill
        ? projectSearchTotalCredits(
            {
              limit: req.body.limit,
              sources: req.body.sources,
              enterprise: req.body.enterprise,
              scrapeOptions: req.body.scrapeOptions,
              filterRiskyURLs: req.body.filterRiskyURLs,
            },
            req.acuc?.flags ?? null,
            zeroDataRetention,
          )
        : 0;
    if (projectedKeylessCredits > 0) {
      const reservation = await reserveKeylessCredits(
        req.auth.team_id,
        projectedKeylessCredits,
      );
      if (!reservation.ok) {
        applyAgentAuthDiscoveryHeader(res);
        return res.status(429).json({
          success: false,
          error: KEYLESS_CREDITS_MESSAGE,
        });
      }
      reservedKeylessCredits = projectedKeylessCredits;
    }

    const result = await executeSearch(
      {
        query: req.body.query,
        limit: req.body.limit,
        tbs: req.body.tbs,
        filter: req.body.filter,
        lang: req.body.lang,
        country: req.body.country,
        location: req.body.location,
        sources: req.body.sources as Array<{ type: string }>,
        categories: req.body.categories as CategoryOption[],
        includeDomains: req.body.includeDomains,
        excludeDomains: req.body.excludeDomains,
        enterprise: req.body.enterprise,
        scrapeOptions: req.body.scrapeOptions,
        highlights: req.body.highlights,
        filterRiskyURLs: req.body.filterRiskyURLs,
        timeout: req.body.timeout,
      },
      {
        teamId: req.auth.team_id,
        origin: req.body.origin,
        apiKeyId: req.acuc?.api_key_id ?? null,
        flags: req.acuc?.flags ?? null,
        requestId: agentRequestId ?? jobId,
        jobId,
        apiVersion: "v2",
        bypassBilling: !shouldBill,
        zeroDataRetention,
        billing,
        agentIndexOnly: (req as any).agentIndexOnly ?? false,
        keylessReserved: reservedKeylessCredits > 0,
      },
      logger,
    );

    // Bill team for search credits only (scrape jobs bill themselves)
    if (!isSearchPreview && shouldBill) {
      billTeam(
        req.auth.team_id,
        req.acuc?.sub_id ?? undefined,
        result.searchCredits,
        req.acuc?.api_key_id ?? null,
        billing,
      ).catch(error =>
        logger.error(
          `Failed to bill team ${req.acuc?.sub_id} for ${result.searchCredits} credits: ${error}`,
        ),
      );
    }

    if (reservedKeylessCredits > 0) {
      reconciledKeylessCredits = true;
      adjustKeylessCredits(
        req.auth.team_id,
        result.totalCredits - reservedKeylessCredits,
      ).catch(() => {});
      logKeylessCreditUsage(req.auth.team_id, result.totalCredits).catch(
        () => {},
      );
    }

    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;

    logSearch(
      {
        id: jobId,
        request_id: agentRequestId ?? jobId,
        query: req.body.query,
        is_successful: true,
        error: undefined,
        results: result.response as any,
        num_results: result.totalResultsCount,
        time_taken: timeTakenInSeconds,
        team_id: req.auth.team_id,
        options: req.body,
        credits_cost: shouldBill ? result.searchCredits : 0,
        zeroDataRetention,
      },
      false,
    );

    const totalRequestTime = new Date().getTime() - middlewareStartTime;
    const controllerTime = new Date().getTime() - controllerStartTime;

    logger.info("Request metrics", {
      version: "v2",
      jobId,
      mode: "search",
      middlewareStartTime,
      controllerStartTime,
      middlewareTime,
      controllerTime,
      totalRequestTime,
      searchCredits: result.searchCredits,
      scrapeCredits: result.scrapeCredits,
      totalCredits: result.totalCredits,
      scrapeful: result.shouldScrape,
    });

    return res.status(200).json({
      success: true,
      data: result.response,
      creditsUsed: result.totalCredits,
      id: jobId,
    });
  } catch (error) {
    if (reservedKeylessCredits > 0 && !reconciledKeylessCredits) {
      reconciledKeylessCredits = true;
      adjustKeylessCredits(req.auth.team_id, -reservedKeylessCredits).catch(
        () => {},
      );
    }

    if (error instanceof z.ZodError) {
      logger.warn("Invalid request body", { error: error.issues });
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
      });
    }

    if (error instanceof ScrapeJobTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }

    captureExceptionWithZdrCheck(error, {
      extra: { zeroDataRetention },
    });
    logger.error("Unhandled error occurred in search", {
      version: "v2",
      error,
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
