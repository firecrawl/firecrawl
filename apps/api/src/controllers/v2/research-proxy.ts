import express, { Request, Response } from "express";
import { Agent, fetch } from "undici";
import { z } from "zod";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../config";
import { logger as rootLogger } from "../../lib/logger";
import { chargeKeylessCredits } from "../../lib/keyless";
import { billTeam } from "../../services/billing/credit_billing";
import { getSearchForcedKind } from "../../lib/zdr-helpers";
import {
  logRequest,
  logResearchEndpoint,
} from "../../services/logging/log_job";
import type {
  ResearchRequestKind,
  ResearchTableName,
} from "../../services/logging/log_job";
import type { RequestWithAuth } from "../v1/types";
import { wrap } from "../../routes/shared";
import { integrationSchema } from "../../utils/integration";

const TIMEOUT_MS = 120_000;
const SEARCH_CREDITS_PER_TEN_RESULTS = 2;
const ZDR_SEARCH_CREDITS_PER_TEN_RESULTS = 10;

const FORWARDED_REQUEST_HEADERS = ["accept", "x-request-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-request-id"];

const dispatcher = new Agent({
  connectTimeout: TIMEOUT_MS,
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

const multiString = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform(value => {
    if (!value) return undefined;
    return Array.isArray(value) ? value : [value];
  });

const kSchema = (max: number) =>
  z.coerce.number().int().positive().max(max).optional();

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

const commonQuery = {
  origin: z.string().optional(),
  integration: integrationSchema.optional(),
};

const searchPapersSchema = z.strictObject({
  query: z.string().min(1),
  k: kSchema(500),
  authors: multiString,
  categories: multiString,
  from: dateSchema,
  to: dateSchema,
  ...commonQuery,
});

const paperSchema = z
  .strictObject({
    query: z.string().min(1).optional(),
    k: kSchema(50),
    ...commonQuery,
  })
  .refine(value => value.query !== undefined || value.k === undefined, {
    message: "k is only valid when query is present",
    path: ["k"],
  });

const similarPapersSchema = z.strictObject({
  intent: z.string().min(1),
  mode: z.enum(["similar", "citers", "references"]).optional(),
  k: kSchema(500),
  rerank: z
    .enum(["true", "false"])
    .optional()
    .transform(value => (value === undefined ? undefined : value === "true")),
  anchor: multiString,
  ...commonQuery,
});

const githubSearchSchema = z.strictObject({
  query: z.string().min(1),
  k: kSchema(100),
  ...commonQuery,
});

type ResearchEndpointConfig = {
  kind: ResearchRequestKind;
  table: ResearchTableName;
  action: string;
  targetHint: (
    params: Record<string, any>,
    req: RequestWithAuth<any, any, any>,
  ) => string;
  upstreamPath: (
    params: Record<string, any>,
    req: RequestWithAuth<any, any, any>,
  ) => string;
  billAs: "scrape" | "search";
};

type ResearchController = (req: Request, res: Response) => Promise<any>;
type ResearchQueryParams = Record<string, any> & {
  origin?: string;
  integration?: string;
};

const LEGACY_SNAKE_CASE_ALIASES: Record<string, string> = {
  paperId: "paper_id",
  primaryId: "primary_id",
  createdDate: "created_date",
  updateDate: "update_date",
  articleRank: "article_rank",
  seedOverlap: "seed_overlap",
  poolSize: "pool_size",
  resultType: "result_type",
  pageType: "page_type",
  segmentCount: "segment_count",
  readmeUrl: "readme_url",
  contentMd: "content_md",
};

function addLegacySnakeCaseAliases<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(addLegacySnakeCaseAliases) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const object: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(source)) {
    object[key] = addLegacySnakeCaseAliases(item);
  }

  for (const [camelKey, snakeKey] of Object.entries(
    LEGACY_SNAKE_CASE_ALIASES,
  )) {
    if (Object.prototype.hasOwnProperty.call(source, camelKey)) {
      object[snakeKey] = object[camelKey];
    }
  }

  return object as T;
}

function appendQuery(
  url: URL,
  params: Record<string, unknown>,
  allowed: string[],
) {
  for (const key of allowed) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          url.searchParams.append(key, String(item));
        }
      }
    } else if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  }
}

function resultCount(body: any): number {
  return Array.isArray(body?.results) ? body.results.length : 0;
}

function firstHeaderValue(req: Request, key: string): string | undefined {
  const value = req.headers[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function requestOrigin(params: ResearchQueryParams, req: Request) {
  return params.origin ?? firstHeaderValue(req, "x-origin") ?? "api";
}

function creditsFor(
  config: ResearchEndpointConfig,
  body: any,
  req: RequestWithAuth<any, any, any>,
) {
  if (config.billAs === "scrape") return 1;
  const forcedKind = getSearchForcedKind(req.acuc?.flags);
  const perTen =
    forcedKind === "zdr"
      ? ZDR_SEARCH_CREDITS_PER_TEN_RESULTS
      : SEARCH_CREDITS_PER_TEN_RESULTS;
  return Math.ceil(resultCount(body) / 10) * perTen;
}

function researchError(
  res: Response,
  status: number,
  error: string,
  details?: unknown,
) {
  return res.status(status).json({
    success: false,
    error,
    ...(details === undefined ? {} : { details }),
  });
}

async function fetchResearchUpstream(
  req: RequestWithAuth<any, any, any>,
  path: string,
  params: Record<string, unknown>,
  queryKeys: string[],
) {
  const base = config.RESEARCH_PROXY_URL;
  if (!base) return null;

  const url = new URL(base.replace(/\/+$/, "") + path);
  appendQuery(url, params, queryKeys);

  const headers: Record<string, string> = {};
  for (const h of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  headers["firecrawl-team-id"] = req.auth.team_id;

  return fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    dispatcher,
  });
}

function createResearchController(
  schema: z.ZodTypeAny,
  queryKeys: string[],
  endpoint: ResearchEndpointConfig,
  options: { legacy?: boolean } = {},
): ResearchController {
  return async (req, res: Response) => {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const started = Date.now();
    const jobId = uuidv7();
    const logger = rootLogger.child({
      module: "api/v2/research",
      method: endpoint.action,
      jobId,
      teamId: authedReq.auth.team_id,
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      logger.warn("Invalid research query", { error: parsed.error.issues });
      return researchError(
        res,
        400,
        "Invalid query parameters",
        parsed.error.issues,
      );
    }

    const params = parsed.data as ResearchQueryParams;
    const targetHint = endpoint.targetHint(params, authedReq);
    await logRequest({
      id: jobId,
      kind: endpoint.kind,
      api_version: "v2",
      team_id: authedReq.auth.team_id,
      origin: requestOrigin(params, req),
      integration: params.integration ?? null,
      target_hint: targetHint,
      zeroDataRetention: false,
      api_key_id: authedReq.acuc?.api_key_id ?? null,
    });

    let statusCode = 500;
    let responseBody: any = null;
    let error: string | undefined;
    let credits = 0;

    try {
      const upstream = await fetchResearchUpstream(
        authedReq,
        endpoint.upstreamPath(params, authedReq),
        params,
        queryKeys,
      );
      if (!upstream) {
        statusCode = 404;
        error = "Research service is not configured";
        return res.status(404).end();
      }

      statusCode = upstream.status;
      for (const h of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(h);
        if (value) res.setHeader(h, value);
      }

      const text = await upstream.text();
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        responseBody = text;
      }

      if (upstream.ok) {
        credits = creditsFor(endpoint, responseBody, authedReq);
        if (credits > 0) {
          billTeam(
            authedReq.auth.team_id,
            credits,
            authedReq.acuc?.api_key_id ?? null,
            {
              endpoint: endpoint.billAs === "scrape" ? "scrape" : "search",
              jobId,
            },
          ).catch(billingError => {
            logger.error("Failed to bill research request", {
              error: billingError,
              credits,
            });
          });
          chargeKeylessCredits(authedReq.auth.team_id, credits).catch(() => {});
        }
      } else {
        error =
          typeof responseBody === "object" && responseBody !== null
            ? (responseBody.detail ?? responseBody.error ?? responseBody.title)
            : undefined;
      }

      if (responseBody === null || typeof responseBody === "string") {
        return res.status(statusCode).send(responseBody ?? "");
      }
      const response =
        options.legacy && upstream.ok
          ? addLegacySnakeCaseAliases(responseBody)
          : responseBody;
      return res.status(statusCode).json(response);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        statusCode = 504;
        error = "Research service timed out";
        return res.status(504).end();
      }
      statusCode = 502;
      error = "Research proxy error";
      logger.error("Research proxy error", { error: err });
      return res.status(502).end();
    } finally {
      const timeTaken = (Date.now() - started) / 1000;
      logResearchEndpoint({
        table: endpoint.table,
        id: jobId,
        request_id: jobId,
        team_id: authedReq.auth.team_id,
        target: targetHint,
        options: params,
        response: responseBody,
        num_results: resultCount(responseBody),
        time_taken: timeTaken,
        credits_cost: statusCode >= 200 && statusCode < 300 ? credits : 0,
        is_successful: statusCode >= 200 && statusCode < 300,
        error,
        zeroDataRetention: false,
      }).catch(logError => {
        logger.warn("Research endpoint log failed", { error: logError });
      });
    }
  };
}

export function createResearchRouter(options: { legacy?: boolean } = {}) {
  const router = express.Router();

  if (options.legacy) {
    router.use((req, _res, next) => {
      rootLogger.warn("Legacy research endpoint used", {
        module: "api/v2/research",
        teamId: (req as RequestWithAuth<any, any, any>).auth?.team_id,
        method: req.method,
        path: req.originalUrl,
        requestId: req.headers["x-request-id"],
      });
      next();
    });
  }

  router.get(
    "/papers",
    wrap(
      createResearchController(
        searchPapersSchema,
        ["query", "k", "authors", "categories", "from", "to"],
        {
          kind: "research_paper_search",
          table: "research_paper_searches",
          action: "searchPapers",
          targetHint: params => String(params.query),
          upstreamPath: () => "/v2/research/papers",
          billAs: "search",
        },
        options,
      ),
    ),
  );

  router.get(
    "/papers/:id/similar",
    wrap(
      createResearchController(
        similarPapersSchema,
        ["intent", "mode", "k", "rerank", "anchor"],
        {
          kind: "research_related_papers",
          table: "research_related_papers",
          action: "similarPapers",
          targetHint: (params, req) =>
            `${req.params.id}: ${String(params.intent)}`,
          upstreamPath: (_params, req) =>
            `/v2/research/papers/${encodeURIComponent(req.params.id)}/similar`,
          billAs: "search",
        },
        options,
      ),
    ),
  );

  router.get(
    "/papers/:id",
    wrap(async (req: Request, res: Response) => {
      const authedReq = req as RequestWithAuth<any, any, any>;
      const parsed = paperSchema.safeParse(req.query);
      const isRead = parsed.success && parsed.data.query !== undefined;
      const controller = createResearchController(
        paperSchema,
        ["query", "k"],
        {
          kind: isRead ? "research_paper_read" : "research_paper_inspect",
          table: isRead ? "research_paper_reads" : "research_paper_inspects",
          action: isRead ? "readPaper" : "inspectPaper",
          targetHint: (_params, request) => request.params.id,
          upstreamPath: (_params, request) =>
            `/v2/research/papers/${encodeURIComponent(request.params.id)}`,
          billAs: "scrape",
        },
        options,
      );
      return controller(authedReq, res);
    }),
  );

  router.get(
    "/github",
    wrap(
      createResearchController(
        githubSearchSchema,
        ["query", "k"],
        {
          kind: "research_github_search",
          table: "research_github_searches",
          action: "searchGithub",
          targetHint: params => String(params.query),
          upstreamPath: () => "/v2/research/github",
          billAs: "search",
        },
        options,
      ),
    ),
  );

  return router;
}
