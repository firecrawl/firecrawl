import { Response } from "express";

import { getV2RequestSchemas, RequestWithAuth, SearchResponse } from "./types";
import type { SearchRequest } from "../../service/request";
import { v7 as uuidv7 } from "uuid";
import { requestContext } from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import {
  finalizeResponse,
  service,
  type RequestContext,
  type SettleOutcome,
} from "../../service";
import { logger as _logger } from "../../lib/logger";
import { getErrorHttpResponse, ScrapeJobTimeoutError } from "../../lib/error";
import { z } from "zod";
import { CategoryOption } from "../../lib/search-query-builder";
import { executeSearch } from "../../search/execute";
import { applySearchPlanHook } from "../../search/plan-hook";
import type { BillingMetadata } from "../../lib/billing-types";
import type { TeamPlanClass } from "../../service/search-providers";
import {
  withSpan,
  setSpanAttributes,
  recordSpanException,
  SpanKind,
  type Span,
} from "../../lib/otel-tracer";
import { installedService } from "../../service/service";

const IMAGE_SEARCH_US_ONLY_MESSAGE =
  "Image search is not available for teams restricted to US-only processing.";

export async function searchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
) {
  const rawBody = req.body as Record<string, any> | undefined;
  const enterprise: unknown[] = Array.isArray(rawBody?.enterprise)
    ? rawBody.enterprise
    : [];
  const zeroDataRetentionTrace =
    req.ctx?.zeroDataRetention === true ||
    enterprise.includes("zdr") ||
    enterprise.includes("anon");

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

  const jobId = req.requestId ?? uuidv7();
  let zeroDataRetention = req.ctx?.zeroDataRetention === true;
  const extBody = () => req.body as Record<string, any>;
  let logger = _logger.child({
    jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "searchController",
    zeroDataRetention,
  });

  const middlewareTime = controllerStartTime - middlewareStartTime;

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
    if (!req.ctx) {
      const rawBody = req.body as unknown as
        | Record<string, unknown>
        | undefined;
      delete rawBody?.objective;
      delete rawBody?.clientModel;
      req.body = getV2RequestSchemas().search.parse(req.body);
    }

    const requestedFormats = req.body.scrapeOptions?.formats ?? [];
    let usOnlyImagesWarning: string | undefined;

    const shouldBill = extBody().__agentInterop?.shouldBill ?? true;
    const agentRequestId = extBody().__agentInterop?.requestId ?? null;
    const billing: BillingMetadata = req.ctx?.billing ?? {
      ...(extBody().__agentInterop
        ? { endpoint: "agent" as const, jobId }
        : { endpoint: "search" as const, jobId }),
      hostedMcp: req.auth.hostedMcp,
    };

    logger = logger.child({
      version: "v2",
      query: req.body.query,
      origin: req.body.origin,
    });

    const isZDR = (
      extBody().enterprise as ("default" | "anon" | "zdr")[] | undefined
    )?.includes("zdr");
    const isAnon = (
      extBody().enterprise as ("default" | "anon" | "zdr")[] | undefined
    )?.includes("anon");
    const isZDROrAnon = isZDR || isAnon;
    zeroDataRetention = req.ctx?.zeroDataRetention ?? Boolean(isZDROrAnon);
    logger = logger.child({ zeroDataRetention });

    const ctx: RequestContext = req.ctx
      ? req.ctx.billing
        ? req.ctx
        : { ...req.ctx, billing }
      : requestContext({
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
    if (!agentRequestId) jobIdField = { jobId };

    const searchState: Record<string, unknown> = {};
    const reservation = await service.modules.billing.authorize({
      caller: req.caller ?? { teamId: req.auth.team_id },
      operation: "search",
      stage: "reserve",
      requestedUnits: req.body.limit,
      ctx,
      state: {
        req,
        shouldBill,
        hasScrapeFormats: requestedFormats.length > 0,
        limit: req.body.limit,
        categories: req.body.categories,
        sources: req.body.sources,
        domainTools: extBody().domainTools,
        enterprise: extBody().enterprise as
          | ("default" | "anon" | "zdr")[]
          | undefined,
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

    const planHooks = installedService()?.hooks;
    const planned = planHooks?.has("search.plan")
      ? await applySearchPlanHook(
          {
            query: req.body.query,
            limit: req.body.limit,
            sources: req.body.sources as Array<{ type: string }>,
          },
          { ctx, body: req.body, state: searchState, logger },
        )
      : {
          query: req.body.query,
          limit: req.body.limit,
          sources: req.body.sources as Array<{ type: string }>,
        };

    if (planHooks?.has("search.plan")) {
      if (
        (ctx.usOnly || ctx.flags?.usOnly) &&
        planned.sources.some(source => source.type === "images")
      ) {
        planned.sources = planned.sources.filter(
          source => source.type !== "images",
        );
        if (
          planned.sources.length === 0 &&
          !Array.isArray(searchState.routedResults)
        ) {
          await settleBilling({ ok: false });
          return res.status(403).json({
            success: false,
            code: "US_ONLY_UNAVAILABLE",
            error: IMAGE_SEARCH_US_ONLY_MESSAGE,
          });
        }
        usOnlyImagesWarning = IMAGE_SEARCH_US_ONLY_MESSAGE;
      }
    }

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
        enterprise: extBody().enterprise as
          | ("default" | "anon" | "zdr")[]
          | undefined,
        scrapeOptions: req.body.scrapeOptions,
        highlights: extBody().highlights,
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
        teamPlanClass: (req.caller as { planClass?: TeamPlanClass } | undefined)
          ?.planClass,
        requestId: agentRequestId ?? jobId,
        jobId,
        apiVersion: "v2",
        bypassBilling: !shouldBill,
        zeroDataRetention,
        billing,
        agentIndexOnly: (req as any).agentIndexOnly ?? false,
        keylessReserved: billingHandle !== undefined,
        ...(req.headers["x-firecrawl-work-contact-only"] === "true"
          ? { workContactOnly: true }
          : {}),
        ctx,
        body: req.body,
        planApplied: true,
        state: searchState,
      },
      logger,
    );

    if (
      searchState.toolsOnly === true &&
      searchState.toolsUnavailable === true
    ) {
      const error =
        "Tool discovery is temporarily unavailable. Retry the request.";
      setSpanAttributes(span, { "search.status_code": 503 });
      const totalRequestTime = Date.now() - middlewareStartTime;
      const hooks = installedService()?.hooks;
      if (hooks?.has("search.finished")) {
        hooks.observe("search.finished", {
          id: jobId,
          requestId: agentRequestId ?? jobId,
          ctx,
          results: 0,
          charged:
            reservation.bypassBilling !== true && shouldBill ? 0 : undefined,
          body: req.body,
          response: result.response,
          timeTakenMs: totalRequestTime,
          isSuccessful: false,
          error,
          state: searchState,
        });
      }
      await settleBilling({ ok: false });
      return res.status(503).json({
        success: false,
        code: "TOOL_DISCOVERY_UNAVAILABLE",
        error,
        ...jobIdField,
      });
    }

    const scrapedDocuments = result.scrapedDocuments ?? [];
    const billableResultsCount =
      result.billableResultsCount ?? result.totalResultsCount;
    // Bills search results only; each scraped document is already billed via kind: "scrape".
    const searchCredits =
      reservation.bypassBilling !== true && shouldBill
        ? await service.modules.billing
            .charge({
              kind: "search",
              ctx,
              requestId: jobId,
              results: billableResultsCount,
              documents: scrapedDocuments,
              state: {
                ...searchState,
                enterprise: extBody().enterprise as
                  | ("default" | "anon" | "zdr")[]
                  | undefined,
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
    const totalRequestTime = endTime - middlewareStartTime;
    const controllerTime = endTime - controllerStartTime;

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
        requestId: agentRequestId ?? jobId,
        ctx,
        results: result.totalResultsCount,
        charged: searchCredits,
        scrapeCredits,
        totalCredits,
        body: req.body,
        response: result.response,
        timeTakenMs: totalRequestTime,
        resultCountsBySource: result.resultCountsBySource,
        resultCategories: result.resultCategories,
        searchTypes: result.searchTypes,
        scrapeFormats: result.scrapeFormats,
        shouldScrape: result.shouldScrape,
        state: searchState,
      });
    }
    const warning = [
      ...(req.requestWarnings ?? []),
      usOnlyImagesWarning,
      result.usOnlyWarning,
    ]
      .filter(Boolean)
      .join(" ");
    await settleBilling({ ok: true, charged: totalCredits });
    const payload = await finalizeResponse(
      req,
      "search",
      {
        success: true,
        data: result.response,
        ...(totalCredits !== undefined ? { creditsUsed: totalCredits } : {}),
        id: jobId,
        ...(warning ? { warning } : {}),
      },
      scrapedDocuments,
    );
    return res.status(200).json(payload as SearchResponse);
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
