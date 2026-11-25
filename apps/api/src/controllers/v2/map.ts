import { Response } from "express";
import {
  getV2RequestSchemas,
  RequestWithAuth,
  MapRequest,
  MapResponse,
} from "./types";
import { configDotenv } from "dotenv";
import { requestContext } from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import { finalizeResponse, service, type RequestContext } from "../../service";
import { logger as _logger } from "../../lib/logger";
import { MapTimeoutError } from "../../lib/error";
import { getMapResults, MapResult } from "../../lib/map-utils";
import { v7 as uuidv7 } from "uuid";
import { isBaseDomain, extractBaseDomain } from "../../lib/url-utils";
import { installedService } from "../../service/service";

configDotenv();

export async function mapController(
  req: RequestWithAuth<{}, MapResponse, MapRequest>,
  res: Response<MapResponse>,
) {
  const zeroDataRetention = req.ctx?.zeroDataRetention === true;
  const mapId = req.requestId ?? uuidv7();
  req.requestId ??= mapId;
  const logger = _logger.child({
    jobId: mapId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "mapController",
    zeroDataRetention,
  });
  // Get timing data from middleware (includes all middleware processing time)
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const originalRequest = req.rawRequestBody ?? req.body;
  if (!req.ctx) {
    req.body = getV2RequestSchemas().map.parse(req.body);
  }
  const extBody = req.body as Record<string, any>;

  const middlewareTime = controllerStartTime - middlewareStartTime;

  const billing = req.ctx?.billing ?? {
    endpoint: "map" as const,
    jobId: mapId,
    hostedMcp: req.auth.hostedMcp,
  };
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
        billing,
      });
  req.ctx = ctx;

  logger.info("Map request", {
    request: req.body,
    originalRequest,
    teamId: req.auth.team_id,
    mapId,
  });

  let result: MapResult;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const abort = new AbortController();
  try {
    result = (await Promise.race([
      getMapResults({
        url: req.body.url,
        search: req.body.search,
        limit: req.body.limit,
        includeSubdomains: req.body.includeSubdomains,
        crawlerOptions: {
          ...req.body,
          sitemap: req.body.sitemap,
        },
        origin: req.body.origin,
        teamId: req.auth.team_id,
        orgId: req.acuc?.org_id ?? null,
        allowExternalLinks: req.body.allowExternalLinks,
        abort: abort.signal,
        mock: req.body.useMock,
        filterByPath: req.body.filterByPath !== false,
        flags: req.acuc?.flags ?? null,
        useIndex: extBody.useIndex,
        ignoreCache: extBody.ignoreCache,
        location: req.body.location,
        headers: req.body.headers,
        id: mapId,
        ctx,
      }),
      ...(req.body.timeout !== undefined
        ? [
            new Promise(
              (_resolve, reject) =>
                (timeoutHandle = setTimeout(() => {
                  abort.abort(new MapTimeoutError());
                  reject(new MapTimeoutError());
                }, req.body.timeout)),
            ),
          ]
        : []),
    ])) as any;
  } catch (error) {
    if (error instanceof MapTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
        jobId: mapId,
      });
    } else {
      throw error;
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  const creditsToBill = await service.modules.billing
    .charge({
      kind: "map",
      ctx,
      requestId: mapId,
      urls: result.mapResults.length,
      state: result.state ?? {},
    })
    .catch(error => {
      logger.error("Failed to bill team for map credits", {
        teamId: req.auth.team_id,
        mapId,
        error,
      });
      return undefined;
    });

  const hooks = installedService()?.hooks;
  if (hooks?.has("map.finished")) {
    hooks.observe("map.finished", {
      id: result.job_id,
      requestId: result.job_id,
      url: req.body.url,
      ctx,
      urls: result.mapResults.length,
      links: result.mapResults,
      charged: creditsToBill,
      options: {
        search: req.body.search,
        sitemap: req.body.sitemap,
        includeSubdomains: req.body.includeSubdomains,
        ignoreQueryParameters: req.body.ignoreQueryParameters,
        limit: req.body.limit,
        timeout: req.body.timeout,
        location: req.body.location,
      },
      timeTakenMs: Date.now() - middlewareStartTime,
      state: result.state,
    });
  }

  // Log final timing information
  const totalRequestTime = new Date().getTime() - middlewareStartTime;
  const controllerTime = new Date().getTime() - controllerStartTime;

  logger.info("Request metrics", {
    version: "v2",
    jobId: result.job_id,
    mode: "map",
    middlewareStartTime,
    controllerStartTime,
    middlewareTime,
    controllerTime,
    totalRequestTime,
    linksCount: result.mapResults.length,
  });

  // Check if we should warn about base domain
  let warning: string | undefined;
  // Only show warning if results <= 1 AND user didn't explicitly request limit=1 AND URL is not base domain
  if (
    result.mapResults.length <= 1 &&
    req.body.limit !== 1 &&
    !isBaseDomain(req.body.url)
  ) {
    const baseDomain = extractBaseDomain(req.body.url);
    if (baseDomain) {
      warning = `Only ${result.mapResults.length} result(s) found. For broader coverage, try mapping the base domain: ${baseDomain}`;
    }
  }

  const response = await finalizeResponse(req, "map", {
    success: true as const,
    id: result.job_id,
    links: result.mapResults,
    ...(warning && { warning }),
  });

  return res.status(200).json(response as MapResponse);
}
