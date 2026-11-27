import type { Response } from "express";

import type {
  DefaultRequestParams,
  ErrorResponse,
  RequestWithAuth,
  SearchResponse,
} from "./types";
import { getV2RequestSchemas } from "./types";
import type { SearchRequest } from "../../service/request";
import { v7 as uuidv7 } from "uuid";
import { requestContext } from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import { finalizeResponse, service } from "../../service";
import type {
  RequestContext,
  ResponsePayload,
  SearchState,
  SettleOutcome,
} from "../../service";
import { logger as _logger } from "../../lib/logger";
import { getErrorHttpResponse, ScrapeJobTimeoutError } from "../../lib/error";
import { z } from "zod";
import { executeSearch } from "../../search/execute";
import { applySearchPlanHook } from "../../search/plan-hook";
import type { BillingMetadata } from "../../lib/billing-types";
import type { TeamPlanClass } from "../../service/search-providers";
import {
  withSpan,
  setSpanAttributes,
  recordSpanException,
  SpanKind,
} from "../../lib/otel-tracer";
import type { Span } from "../../lib/otel-tracer";
import { installedService } from "../../service/service";
import { jsonRecordSchema } from "../../lib/json-types";
import {
  readAgentInterop,
  readBooleanField,
  readOptionalBooleanField,
} from "./agent-interop";

const IMAGE_SEARCH_US_ONLY_MESSAGE =
  "Image search is not available for teams restricted to US-only processing.";

const enterpriseSearchModeSchema = z.enum(["default", "anon", "zdr"]);
type EnterpriseSearchMode = z.infer<typeof enterpriseSearchModeSchema>;

interface JobIdField {
  jobId?: string;
}

const enterpriseModesBodySchema = z.object({
  enterprise: z.array(z.unknown()),
});

const callerPlanClassSchema = z.object({
  planClass: z.enum(["free", "self_serve", "contract"]),
});

function readEnterpriseModes(
  body: unknown,
): Array<EnterpriseSearchMode> | undefined {
  const parsed = enterpriseModesBodySchema.safeParse(body);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.enterprise.flatMap(item => {
    const mode = enterpriseSearchModeSchema.safeParse(item);
    return mode.success ? [mode.data] : [];
  });
}

function readTeamPlanClass(caller: unknown): TeamPlanClass | undefined {
  const parsed = callerPlanClassSchema.safeParse(caller);
  return parsed.success ? parsed.data.planClass : undefined;
}

function parseSearchRequestBody(body: unknown): SearchRequest {
  const parsed = jsonRecordSchema.safeParse(body);
  if (!parsed.success) {
    return getV2RequestSchemas().search.parse(body);
  }
  const {
    objective: _objective,
    clientModel: _clientModel,
    ...rest
  } = parsed.data;
  return getV2RequestSchemas().search.parse(rest);
}

export async function searchController(
  req: RequestWithAuth<DefaultRequestParams, SearchResponse, SearchRequest>,
  res: Response<SearchResponse | ResponsePayload>,
) {
  const enterprise = readEnterpriseModes(req.body) ?? [];
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
  req: RequestWithAuth<DefaultRequestParams, SearchResponse, SearchRequest>,
  res: Response<SearchResponse | ResponsePayload>,
  span: Span,
) {
  const middlewareStartTime =
    req.requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const jobId = req.requestId ?? uuidv7();
  let zeroDataRetention = req.ctx?.zeroDataRetention === true;
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
  let jobIdField: JobIdField = {};

  const settleBilling = async (outcome: SettleOutcome) => {
    if (billingHandle === undefined || settledBilling) {
      return;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await service.modules.billing.settle?.(billingHandle, outcome);
        settledBilling = true;
        return;
      } catch (settleError: unknown) {
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
      req.body = parseSearchRequestBody(req.body);
    }

    const requestedFormats = req.body.scrapeOptions?.formats ?? [];
    let usOnlyImagesWarning: string | undefined;

    const agentInterop = readAgentInterop(req.body);
    const enterpriseModes = readEnterpriseModes(req.body);
    const shouldBill = agentInterop?.shouldBill ?? true;
    const agentRequestId = agentInterop?.requestId ?? null;
    const billing: BillingMetadata = req.ctx?.billing ?? {
      ...(agentInterop
        ? { endpoint: "agent" as const, jobId }
        : { endpoint: "search" as const, jobId }),
      hostedMcp: req.auth.hostedMcp,
    };

    logger = logger.child({
      version: "v2",
      query: req.body.query,
      origin: req.body.origin,
    });

    const isZDR = enterpriseModes?.includes("zdr");
    const isAnon = enterpriseModes?.includes("anon");
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
    if (!agentRequestId) {
      jobIdField = { jobId };
    }

    const searchState: SearchState = {};
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
        domainTools: readOptionalBooleanField(req.body, "domainTools"),
        enterprise: enterpriseModes,
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
      const parsedRefusalBody = jsonRecordSchema.safeParse(
        reservation.refusal.body,
      );
      const refusalBody: ResponsePayload = parsedRefusalBody.success
        ? {
            ...parsedRefusalBody.data,
            ...jobIdField,
          }
        : reservation.refusal.body;
      return res.status(reservation.refusal.status).json(refusalBody);
    }
    billingHandle = reservation.handle;

    const planHooks = installedService()?.hooks;
    const planned = planHooks?.has("search.plan")
      ? await applySearchPlanHook(
          {
            query: req.body.query,
            limit: req.body.limit,
            sources: req.body.sources,
          },
          { ctx, body: req.body, state: searchState, logger },
        )
      : {
          query: req.body.query,
          limit: req.body.limit,
          sources: req.body.sources,
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

    const searchContext: Parameters<typeof executeSearch>[1] = {
      teamId: req.auth.team_id,
      orgId: req.acuc?.org_id ?? null,
      origin: req.body.origin,
      integration: req.body.integration,
      apiKeyId: req.acuc?.api_key_id ?? null,
      flags: req.acuc?.flags ?? null,
      concurrencyLimit: req.acuc?.concurrency_limit,
      rateLimitMultiplier: req.acuc?.rate_limit_multiplier,
      teamPlanClass: readTeamPlanClass(req.caller),
      requestId: agentRequestId ?? jobId,
      jobId,
      apiVersion: "v2",
      bypassBilling: !shouldBill,
      zeroDataRetention,
      billing,
      agentIndexOnly: readBooleanField(req, "agentIndexOnly"),
      keylessReserved: billingHandle !== undefined,
      ctx,
      body: req.body,
      planApplied: true,
      state: searchState,
    };
    if (req.headers["x-firecrawl-work-contact-only"] === "true") {
      searchContext.workContactOnly = true;
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
        categories: req.body.categories,
        includeDomains: req.body.includeDomains,
        excludeDomains: req.body.excludeDomains,
        enterprise: enterpriseModes,
        scrapeOptions: req.body.scrapeOptions,
        highlights: readOptionalBooleanField(req.body, "highlights"),
        timeout: req.body.timeout,
      },
      searchContext,
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
                enterprise: enterpriseModes,
                threatDecisions: result.threatDecisions,
              },
            })
            .catch((error: unknown) => {
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
    const responsePayload: ResponsePayload = {
      success: true,
      data: result.response,
      id: jobId,
    };
    if (totalCredits !== undefined) {
      responsePayload.creditsUsed = totalCredits;
    }
    if (warning) {
      responsePayload.warning = warning;
    }
    const payload = await finalizeResponse(
      req,
      "search",
      responsePayload,
      scrapedDocuments,
    );
    return res.status(200).json(payload);
  } catch (error: unknown) {
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
      const errorBody: ErrorResponse = {
        ...httpResponse.extraFields,
        success: false,
        error: httpResponse.message,
        ...jobIdField,
      };
      if (httpResponse.code) {
        errorBody.code = httpResponse.code;
      }
      return res.status(httpResponse.status).json(errorBody);
    }

    logger.error("Unhandled error occurred in search", {
      version: "v2",
      error,
    });
    recordSpanException(span, error);
    setSpanAttributes(span, { "search.status_code": 500 });
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...jobIdField,
    });
  }
}
