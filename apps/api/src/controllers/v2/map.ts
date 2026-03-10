import { Response } from "express";
import {
  mapRequestSchema,
  RequestWithAuth,
  MapRequest,
  MapResponse,
} from "./types";
import { configDotenv } from "dotenv";
import { billTeam } from "../../services/billing/credit_billing";
import { logMap, logRequest } from "../../services/logging/log_job";
import { logger as _logger } from "../../lib/logger";
import { MapTimeoutError } from "../../lib/error";
import { checkPermissions } from "../../lib/permissions";
import { getMapResults, MapResult } from "../../lib/map-utils";
import { v7 as uuidv7 } from "uuid";
import { isBaseDomain, extractBaseDomain } from "../../lib/url-utils";

configDotenv();

export async function mapController(
  req: RequestWithAuth<{}, MapResponse, MapRequest>,
  res: Response<MapResponse>,
) {
  const logger = _logger.child({
    jobId: uuidv7(),
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "mapController",
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });
  // Get timing data from middleware (includes all middleware processing time)
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const originalRequest = req.body;
  req.body = mapRequestSchema.parse(req.body);

  const permissions = checkPermissions(req.body, req.acuc?.flags);
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  const middlewareTime = controllerStartTime - middlewareStartTime;

  const mapId = uuidv7();

  logger.info("Map request", {
    request: req.body,
    originalRequest,
    teamId: req.auth.team_id,
    mapId,
  });

  await logRequest({
    id: mapId,
    kind: "map",
    api_version: "v2",
    team_id: req.auth.team_id,
    origin: req.body.origin ?? "api",
    integration: req.body.integration,
    target_hint: req.body.url,
    zeroDataRetention: false, // not supported for map
    api_key_id: req.acuc?.api_key_id ?? null,
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
        allowExternalLinks: req.body.allowExternalLinks,
        abort: abort.signal,
        mock: req.body.useMock,
        filterByPath: req.body.filterByPath !== false,
        flags: req.acuc?.flags ?? null,
        useIndex: req.body.useIndex,
        ignoreCache: req.body.ignoreCache,
        location: req.body.location,
        headers: req.body.headers,
        id: mapId,
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
      });
    } else {
      throw error;
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  // Bill the team
  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id ?? undefined,
    1,
    req.acuc?.api_key_id ?? null,
  ).catch(error => {
    logger.error(
      `Failed to bill team ${req.auth.team_id} for 1 credit: ${error}`,
    );
  });

  logMap({
    id: result.job_id,
    request_id: result.job_id,
    url: req.body.url,
    team_id: req.auth.team_id,
    options: {
      search: req.body.search,
      sitemap: req.body.sitemap,
      includeSubdomains: req.body.includeSubdomains,
      ignoreQueryParameters: req.body.ignoreQueryParameters,
      limit: req.body.limit,
      timeout: req.body.timeout,
      location: req.body.location,
    },
    results: result.mapResults,
    credits_cost: 1,
    zeroDataRetention: false, // not supported
  }).catch(error => {
    logger.error(`Failed to log job for team ${req.auth.team_id}: ${error}`);
  });

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

  const response = {
    success: true as const,
    links: result.mapResults,
    ...(warning && { warning }),
  };

  return res.status(200).json(response);
}
