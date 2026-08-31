import { Response } from "express";
import { externalRequestId } from "../../lib/external-request-id";
import { config } from "../../config";
import {
  RequestWithAuth,
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
} from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import {
  adjustKeylessCredits,
  keylessLimitBody,
  keylessTeamPseudonym,
  logKeylessCreditUsage,
  reserveKeylessCredits,
} from "../../lib/keyless";
import { v7 as uuidv7 } from "uuid";
import {
  logSearch,
  logRequest,
  logResearchEndpoint,
} from "../../services/logging/log_job";
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
import { resolveThreatProtection } from "../../lib/threat-protection/request";
import {
  actionTypesOf,
  checkKeyEndpointRestriction,
  checkKeyFormatRestriction,
  formatTypesOf,
} from "../../lib/key-restriction";
import { wantsDeveloperCategory } from "../../search/developer";
import { requestOrigin } from "../../lib/request-origin";
import { isAgentInteropSecretValid } from "../../lib/agent-interop";

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
    teamId: keylessTeamPseudonym(req.auth.team_id),
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
    const rawOrigin =
      typeof req.body?.origin === "string" ? req.body.origin : undefined;
    req.body = searchRequestSchema.parse(req.body);

    const requestedFormats = formatTypesOf(req.body.scrapeOptions?.formats);
    const keyRestriction = await checkKeyFormatRestriction(
      requestedFormats,
      // Search only scrapes (and only runs actions) when formats are
      // requested; without them scrapeOptions is ignored entirely.
      requestedFormats.length > 0
        ? actionTypesOf(req.body.scrapeOptions?.actions)
        : [],
      req.acuc?.api_key_id,
      req.acuc?.flags ?? null,
    );
    if (!keyRestriction.allowed) {
      return res.status(keyRestriction.status).json({
        success: false,
        error: keyRestriction.error,
      });
    }

    if (wantsDeveloperCategory(req.body.categories as CategoryOption[])) {
      const developerRestriction = await checkKeyEndpointRestriction(
        "/v2/developer/search",
        req.acuc?.api_key_id,
        req.acuc?.flags ?? null,
      );
      if (!developerRestriction.allowed) {
        return res.status(developerRestriction.status).json({
          success: false,
          error: developerRestriction.error,
        });
      }
    }

    if (
      req.body.__agentInterop &&
      config.AGENT_INTEROP_SECRET &&
      !isAgentInteropSecretValid(req.body.__agentInterop.auth)
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

    // Threat protection: resolve the effective policy. Blocked domains are
    // removed from search results entirely, and scraped results inherit the
    // policy through the scrape pipeline.
    const threatProtection = await resolveThreatProtection({
      teamId: req.auth.team_id,
      orgId: req.acuc?.org_id ?? null,
      flags: req.acuc?.flags ?? null,
      override:
        req.body.threatProtection ?? req.body.scrapeOptions?.threatProtection,
    });
    if (threatProtection.error) {
      return res.status(403).json({
        success: false,
        error: threatProtection.error,
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

    // Kick off the `requests` row insert without blocking: it queues on the
    // Postgres pool and can take seconds under pool pressure. We only need it
    // committed before the child-row writes (logSearch et al. below) to keep
    // the request_id FK ordering — same pattern as the scrape controllers.
    let logRequestPromise: Promise<void> | undefined;
    if (!agentRequestId) {
      logRequestPromise = logRequest({
        id: jobId,
        kind: "search",
        api_version: "v2",
        external_request_id: externalRequestId(req),
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
              enterprise: req.body.enterprise,
              scrapeOptions: req.body.scrapeOptions,
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
        return res
          .status(429)
          .json(await keylessLimitBody(req.auth.team_id, "v2_search"));
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
        safe: req.body.safe,
        sources: req.body.sources as Array<{ type: string }>,
        categories: req.body.categories as CategoryOption[],
        includeDomains: req.body.includeDomains,
        excludeDomains: req.body.excludeDomains,
        enterprise: req.body.enterprise,
        scrapeOptions: req.body.scrapeOptions,
        highlights: req.body.highlights,
        timeout: req.body.timeout,
      },
      {
        teamId: req.auth.team_id,
        orgId: req.acuc?.org_id ?? null,
        origin: req.body.origin,
        integration: req.body.integration,
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
        threatProtectionPolicy: threatProtection.policy,
      },
      logger,
    );

    // Bill team for search credits only (scrape jobs bill themselves)
    if (!isSearchPreview && shouldBill) {
      billTeam(
        req.auth.team_id,
        result.searchCredits,
        req.acuc?.api_key_id ?? null,
        { ...billing, chargeId: jobId },
      ).catch(error =>
        logger.error("Failed to bill team for search credits", {
          teamId: keylessTeamPseudonym(req.auth.team_id),
          searchCredits: result.searchCredits,
          error,
        }),
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

    // Ensure the parent `requests` row is committed before the child
    // `searches` insert, to avoid a request_id FK violation. The insert has
    // been in flight since the top of the controller, so this is ~free in
    // practice; robustInsert never rejects, so this await cannot throw.
    const logStart = Date.now();
    await logRequestPromise;
    const waited = Date.now() - logStart;
    if (waited >= 5)
      logger.warn("Had to wait for log request promise to complete", {
        timeMs: waited,
      });

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
        // Don't record preview tokens as billed in the ledger — only record
        // credits when billing is actually applied.
        credits_cost: !isSearchPreview && shouldBill ? result.searchCredits : 0,
        zeroDataRetention,
      },
      false,
    );

    if (wantsDeveloperCategory(req.body.categories as CategoryOption[])) {
      logResearchEndpoint({
        table: "code_searches",
        id: uuidv7(),
        request_id: agentRequestId ?? jobId,
        team_id: req.auth.team_id,
        target: req.body.query,
        options: {
          origin: requestOrigin({ origin: rawOrigin }, req),
          integration: req.body.integration ?? null,
          api_version: "v2",
          categories: req.body.categories,
          via: "search_category",
        },
        response: null,
        num_results: result.developerResultsCount,
        time_taken: timeTakenInSeconds,
        // Ensure preview-mode searches don't get a non-zero credits_cost
        // in the research ledger when preview tokens are used.
        credits_cost: !isSearchPreview && shouldBill ? result.searchCredits : 0,
        is_successful: true,
        zeroDataRetention,
      }).catch(ledgerError => {
        logger.warn("Failed to log developer category usage", {
          error: ledgerError,
        });
      });
    }

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
