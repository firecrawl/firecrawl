import { Response } from "express";
import { externalRequestId } from "../../lib/external-request-id";
import { config } from "../../config";
import { timingSafeSecretEqual } from "../../lib/secret-compare";
import { getV2RequestSchemas, RequestWithAuth, SearchResponse } from "./types";
import type { SearchRequest } from "../../service/request";
import { v7 as uuidv7 } from "uuid";
import { logSearch, logRequest } from "../../services/logging/log_job";
import { trackSearchRequest } from "../../lib/tracking";
import { requestContext } from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import { service, type SettleOutcome } from "../../service";
import { logger as _logger } from "../../lib/logger";
import { getErrorHttpResponse, ScrapeJobTimeoutError } from "../../lib/error";
import { z } from "zod";
import { CategoryOption } from "../../lib/search-query-builder";
import { executeSearch } from "../../search/execute";
import { applySearchPlanHook } from "../../search/plan-hook";
import type { BillingMetadata } from "../../services/billing/types";
import { getSearchForcedKind, getSearchZDR } from "../../lib/zdr-helpers";
import { teamPlanClass } from "../../lib/team-plan-class";
import {
  withSpan,
  setSpanAttributes,
  recordSpanException,
  SpanKind,
  type Span,
} from "../../lib/otel-tracer";
import { resolveThreatProtection } from "../../lib/threat-protection/request";
import {
  resolveSafeMode,
  isLockdownZeroDataRetention,
  getEffectiveSearchForcedKind,
} from "../../lib/safe-mode";
import { checkPermissions, ipWhitelistRefusal } from "../../lib/permissions";
import {
  actionTypesOf,
  checkKeyFormatRestriction,
  formatTypesOf,
} from "../../lib/key-restriction";
import { isAgentInteropSecretValid } from "../../lib/agent-interop";
import { isUsOnly, usOnlyLocationRefusal } from "../../lib/us-only";
import { installedService } from "../../service/service";

const IMAGE_SEARCH_US_ONLY_MESSAGE =
  "Image search is not available for teams restricted to US-only processing.";

export async function searchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
) {
  // Resolved before any span starts so the whole request stays unrecorded for
  // zero-data-retention and anonymous searches (see otel-tracer).
  const enterprise: unknown[] = Array.isArray(req.body?.enterprise)
    ? req.body.enterprise
    : [];
  const zeroDataRetentionTrace =
    Boolean(getSearchForcedKind(req.acuc?.flags)) ||
    enterprise.includes("zdr") ||
    enterprise.includes("anon") ||
    isLockdownZeroDataRetention(
      req.acuc?.flags,
      req.body?.scrapeOptions?.safeMode,
    );

  return withSpan(
    "api.search.request",
    span => searchControllerInner(req, res, span),
    {
      kind: SpanKind.SERVER,
      attributes: {
        "api.version": "v2",
        "search.team_id": req.auth.team_id,
      },
      zeroDataRetention: zeroDataRetentionTrace,
    },
  );
}

async function searchControllerInner(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
  span: Span,
) {
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const jobId = uuidv7();
  const searchZDRMode = getSearchZDR(req.acuc?.flags);
  // Safe Mode lockdown forces the "zdr" kind like the searchZDR flag does
  // (see getEffectiveSearchForcedKind).
  const flagForcedKind = getSearchForcedKind(req.acuc?.flags);
  const teamForcedKind = getEffectiveSearchForcedKind(
    req.acuc?.flags,
    req.body?.scrapeOptions?.safeMode,
  );
  let logger = _logger.child({
    jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "searchController",
    zeroDataRetention: teamForcedKind !== null,
    teamForcedKind,
  });

  const middlewareTime = controllerStartTime - middlewareStartTime;
  const isSearchPreview = timingSafeSecretEqual(
    req.body.__searchPreviewToken,
    config.SEARCH_PREVIEW_TOKEN,
  );

  let zeroDataRetention = teamForcedKind !== null;
  let billingHandle: unknown = undefined;
  let settledBilling = false;
  let jobIdField: { jobId?: string } = {};

  const settleBilling = async (outcome: SettleOutcome) => {
    if (billingHandle === undefined || settledBilling) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await service.modules.billing.settle?.(billingHandle, outcome);
        settledBilling = true;
        return;
      } catch (settleError) {
        if (attempt === 1) {
          logger.error("Failed to settle billing reservation", {
            teamId: req.auth.team_id,
            jobId,
            ok: outcome.ok,
            error: settleError,
          });
        }
      }
    }
  };

  try {
    const rawBody = req.body as unknown as Record<string, unknown> | undefined;
    delete rawBody?.objective;
    delete rawBody?.clientModel;
    req.body = getV2RequestSchemas().search.parse(req.body);

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

    const categories = req.body.categories as CategoryOption[];

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

    // Image search has no US-only route: it is dropped with a warning, or
    // refused when nothing else was asked for.
    let usOnlyImagesWarning: string | undefined;
    const sources = req.body.sources as Array<{ type: string }>;
    if (
      isUsOnly(req.acuc?.flags) &&
      sources.some(source => source.type === "images")
    ) {
      req.body.sources = sources.filter(
        source => source.type !== "images",
      ) as SearchRequest["sources"];
      if (req.body.sources.length === 0) {
        return res.status(403).json({
          success: false,
          code: "US_ONLY_UNAVAILABLE",
          error: IMAGE_SEARCH_US_ONLY_MESSAGE,
        });
      }
      usOnlyImagesWarning = IMAGE_SEARCH_US_ONLY_MESSAGE;
    }

    // Safe Mode: validate the per-request param up front and reject scrape
    // options it forbids (the worker backstop would otherwise strip them
    // silently). Domain controls force threat protection over the results.
    const safeMode = resolveSafeMode(
      req.acuc?.flags,
      req.body.scrapeOptions?.safeMode,
    );
    if (safeMode.error) {
      return res.status(403).json({
        success: false,
        code: safeMode.code,
        error: safeMode.error,
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
      force: safeMode.safeMode?.domainControls === true,
    });
    if (threatProtection.error) {
      return res.status(403).json({
        success: false,
        error: threatProtection.error,
      });
    }

    const usOnlyLocationError =
      requestedFormats.length > 0
        ? usOnlyLocationRefusal(
            req.acuc?.flags,
            req.body.scrapeOptions?.location?.country,
          )
        : undefined;
    if (usOnlyLocationError) {
      return res.status(403).json({
        success: false,
        code: "US_ONLY_UNAVAILABLE",
        error: usOnlyLocationError,
      });
    }

    const ipWhitelistError =
      requestedFormats.length > 0
        ? ipWhitelistRefusal(
            req.acuc?.flags,
            req.body.scrapeOptions?.location?.country,
          )
        : undefined;
    if (ipWhitelistError) {
      return res.status(403).json({
        success: false,
        error: ipWhitelistError,
      });
    }

    // Search only scrapes (and only honors scrapeOptions) when formats are
    // requested, so the scrape-option checks apply only then.
    if (
      safeMode.safeMode &&
      requestedFormats.length > 0 &&
      req.body.scrapeOptions
    ) {
      const permissions = checkPermissions(
        req.body.scrapeOptions,
        req.acuc?.flags,
        {
          threatProtectionOrgConfig: threatProtection.orgConfig,
          safeMode: safeMode.safeMode,
        },
      );
      if (permissions.error) {
        return res.status(403).json({
          success: false,
          code: permissions.code,
          error: permissions.error,
        });
      }
    }

    const shouldBill = req.body.__agentInterop?.shouldBill ?? true;
    const agentRequestId = req.body.__agentInterop?.requestId ?? null;
    const billing: BillingMetadata = {
      ...(req.body.__agentInterop
        ? { endpoint: "agent" as const, jobId }
        : { endpoint: "search" as const, jobId }),
      externalRequestId: externalRequestId(req),
      hostedMcp: req.auth.hostedMcp,
    };

    logger = logger.child({
      version: "v2",
      query: req.body.query,
      origin: req.body.origin,
    });

    // Kinds the request itself asked for, captured before the forced kind is
    // injected: the entitlement check below applies to these only.
    const requestedZDROrAnon =
      req.body.enterprise?.includes("zdr") ||
      req.body.enterprise?.includes("anon") ||
      false;

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

    // Verify the team has searchZDR enabled before allowing enterprise ZDR/anon
    // it asked for. Only the flag-forced kind exempts a team: a lockdown-forced
    // "zdr" must not let an unentitled request add "anon".
    if (requestedZDROrAnon && !flagForcedKind) {
      if (searchZDRMode !== "allowed") {
        return res.status(403).json({
          success: false,
          error:
            "Zero Data Retention (ZDR) search is not enabled for your team. Contact support@firecrawl.com to enable this feature.",
        });
      }
    }

    const ctx =
      req.ctx ??
      requestContext({
        teamId: req.auth.team_id,
        zeroDataRetention,
        flags: req.acuc?.flags ?? null,
        orgId: req.acuc?.org_id ?? null,
        apiKeyId: req.acuc?.api_key_id ?? null,
        concurrencyLimit: req.acuc?.concurrency_limit,
        rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
        billing,
      });
    req.ctx = ctx;

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
      // The rejection is surfaced where the promise is awaited below; this
      // only stops it counting as unhandled until then.
      logRequestPromise.catch(() => {});
    }

    // The request must be on record before anything is reserved, runs, or
    // bills. A failed log fails the request here, ahead of the reservation and
    // the search, so there is nothing to refund or unbill.
    const logStart = Date.now();
    await logRequestPromise;
    const waited = Date.now() - logStart;
    if (waited >= 5)
      logger.warn("Had to wait for log request promise to complete", {
        timeMs: waited,
      });
    if (!agentRequestId) jobIdField = { jobId };

    const planHooks = installedService()?.hooks;
    const planned = planHooks?.has("search.plan")
      ? await applySearchPlanHook(
          {
            query: req.body.query,
            limit: req.body.limit,
            sources: req.body.sources as Array<{ type: string }>,
          },
          { ctx, body: req.body },
        )
      : {
          query: req.body.query,
          limit: req.body.limit,
          sources: req.body.sources as Array<{ type: string }>,
        };

    if (planHooks?.has("search.plan")) {
      if (
        isUsOnly(req.acuc?.flags) &&
        planned.sources.some(source => source.type === "images")
      ) {
        planned.sources = planned.sources.filter(
          source => source.type !== "images",
        );
        if (planned.sources.length === 0) {
          return res.status(403).json({
            success: false,
            code: "US_ONLY_UNAVAILABLE",
            error: IMAGE_SEARCH_US_ONLY_MESSAGE,
          });
        }
        usOnlyImagesWarning = IMAGE_SEARCH_US_ONLY_MESSAGE;
      }
    }

    const reservation = await service.modules.billing.authorize({
      caller: req.caller ?? { teamId: req.auth.team_id },
      operation: "search",
      stage: "reserve",
      requestedUnits: planned.limit,
      ctx,
      state: {
        req,
        shouldBill,
        isPreview: isSearchPreview,
        hasScrapeFormats: requestedFormats.length > 0,
        limit: planned.limit,
        enterprise: req.body.enterprise,
        scrapeOptions: req.body.scrapeOptions,
        endpoint: "v2_search",
      },
    });
    if (!reservation.ok) {
      if (reservation.refusal.headers) {
        for (const [name, value] of Object.entries(
          reservation.refusal.headers,
        )) {
          res.setHeader(name, value);
        }
      }
      const body =
        reservation.refusal.body &&
        typeof reservation.refusal.body === "object" &&
        !Array.isArray(reservation.refusal.body)
          ? {
              ...(reservation.refusal.body as Record<string, unknown>),
              ...jobIdField,
            }
          : reservation.refusal.body;
      return res
        .status(reservation.refusal.status)
        .json(body as SearchResponse);
    }
    billingHandle = reservation.handle;

    const result = await executeSearch(
      {
        query: planned.query,
        limit: planned.limit,
        tbs: req.body.tbs,
        filter: req.body.filter,
        lang: req.body.lang,
        country: req.body.country,
        location: req.body.location,
        safe: req.body.safe,
        sources: planned.sources,
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
        concurrencyLimit: req.acuc?.concurrency_limit,
        rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
        teamPlanClass: teamPlanClass(req.acuc),
        requestId: agentRequestId ?? jobId,
        jobId,
        apiVersion: "v2",
        bypassBilling: !shouldBill,
        zeroDataRetention,
        billing,
        agentIndexOnly: (req as any).agentIndexOnly ?? false,
        keylessReserved: billingHandle !== undefined,
        threatProtectionPolicy: threatProtection.policy,
        safeModeBypassed: safeMode.bypassed === true,
        ...(req.headers["x-firecrawl-work-contact-only"] === "true"
          ? { workContactOnly: true }
          : {}),
        ctx,
        body: req.body,
        planApplied: true,
      },
      logger,
    );

    const scrapedDocuments = result.scrapedDocuments ?? [];
    const billableResultsCount =
      result.billableResultsCount ?? result.totalResultsCount;
    // Bills search results only; each scraped document is already billed via kind: "scrape".
    const searchCredits =
      !isSearchPreview && shouldBill
        ? await service.modules.billing
            .charge({
              kind: "search",
              ctx,
              requestId: jobId,
              results: billableResultsCount,
              documents: scrapedDocuments,
              state: {
                enterprise: req.body.enterprise,
                threatDecisions: result.threatDecisions,
              },
            })
            .catch(error => {
              logger.error("Failed to bill team for search credits", {
                teamId: req.auth.team_id,
                jobId,
                error,
              });
              return undefined;
            })
        : undefined;

    let scrapeCredits: number | undefined;
    for (const doc of scrapedDocuments) {
      if (typeof doc.metadata?.creditsUsed === "number") {
        scrapeCredits = (scrapeCredits ?? 0) + doc.metadata.creditsUsed;
      }
    }
    const totalCredits =
      searchCredits !== undefined || scrapeCredits !== undefined
        ? (searchCredits ?? 0) + (scrapeCredits ?? 0)
        : undefined;
    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;

    trackSearchRequest({
      searchId: jobId,
      requestId: agentRequestId ?? jobId,
      teamId: req.auth.team_id,
      query: req.body.query,
      origin: req.body.origin,
      kind: billing.endpoint,
      apiVersion: "v2",
      lang: req.body.lang,
      country: req.body.country,
      sources: result.searchTypes ?? [],
      numResults: result.totalResultsCount,
      searchCredits: searchCredits ?? 0,
      scrapeCredits: scrapeCredits ?? 0,
      totalCredits: totalCredits ?? 0,
      hasScrapeFormats: result.shouldScrape,
      scrapeFormats: result.scrapeFormats ?? [],
      isSuccessful: true,
      timeTaken: timeTakenInSeconds,
      zeroDataRetention,
    }).catch(err =>
      logger.warn("Search request tracking failed", { error: err }),
    );

    logSearch({
      id: jobId,
      request_id: agentRequestId ?? jobId,
      query: req.body.query,
      is_successful: true,
      error: undefined,
      results: result.response as any,
      num_results: result.totalResultsCount,
      num_results_by_source: result.resultCountsBySource,
      result_categories: result.resultCategories,
      time_taken: timeTakenInSeconds,
      team_id: req.auth.team_id,
      options: req.body,
      credits_cost: searchCredits ?? 0,
      zeroDataRetention,
    }).catch(error => {
      logger.error("Failed to log search", { error, jobId });
    });

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
      searchCredits,
      scrapeCredits,
      totalCredits,
      scrapeful: result.shouldScrape,
    });

    const hooks = installedService()?.hooks;
    if (hooks?.has("search.finished")) {
      hooks.observe("search.finished", {
        id: jobId,
        ctx,
        results: result.totalResultsCount,
        charged: searchCredits,
      });
    }
    const warning = [usOnlyImagesWarning, result.usOnlyWarning]
      .filter(Boolean)
      .join(" ");
    await settleBilling({ ok: true, charged: totalCredits });
    return res.status(200).json({
      success: true,
      data: result.response,
      ...(totalCredits !== undefined ? { creditsUsed: totalCredits } : {}),
      id: jobId,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    await settleBilling({ ok: false });

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
        ...jobIdField,
      });
    }

    const httpResponse = getErrorHttpResponse(error);
    if (httpResponse) {
      setSpanAttributes(span, { "search.status_code": httpResponse.status });
      return res.status(httpResponse.status).json({
        ...httpResponse.extraFields,
        success: false,
        ...(httpResponse.code ? { code: httpResponse.code } : {}),
        error: httpResponse.message,
        ...jobIdField,
      });
    }

    logger.error("Unhandled error occurred in search", {
      version: "v2",
      error,
    });
    recordSpanException(span, error);
    setSpanAttributes(span, { "search.status_code": 500 });
    return res.status(500).json({
      success: false,
      error: error.message,
      ...jobIdField,
    });
  }
}
