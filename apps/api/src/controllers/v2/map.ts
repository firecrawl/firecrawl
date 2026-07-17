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
import { MapTimeoutError, MapFailedError } from "../../lib/error";
import { checkPermissions } from "../../lib/permissions";
import { getMapResults, MapResult } from "../../lib/map-utils";
import { v7 as uuidv7 } from "uuid";
import { isBaseDomain, extractBaseDomain } from "../../lib/url-utils";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { resolveViaAvgrab } from "../../lib/avgrab-resolve";
import {
  checkUrlsAgainstThreatPolicy,
  resolveThreatProtection,
} from "../../lib/threat-protection/request";
import { calculateThreatScanCredits } from "../../lib/scrape-billing";

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
    zeroDataRetention: getScrapeZDR(req.acuc?.flags) === "forced",
  });
  // Get timing data from middleware (includes all middleware processing time)
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const originalRequest = req.body;
  req.body = mapRequestSchema.parse(req.body);

  const threatProtection = await resolveThreatProtection({
    teamId: req.auth.team_id,
    orgId: req.acuc?.org_id ?? null,
    flags: req.acuc?.flags ?? null,
    override: req.body.threatProtection,
  });
  if (threatProtection.error) {
    return res.status(403).json({
      success: false,
      error: threatProtection.error,
    });
  }

  const permissions = checkPermissions(req.body, req.acuc?.flags, {
    threatProtectionOrgConfig: threatProtection.orgConfig,
  });
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

  // Short-circuit: if the URL matches avgrab's resolve pattern, delegate entirely
  try {
    const avgrabResults = await resolveViaAvgrab(
      req.body.url,
      req.body.limit,
      logger,
    );

    if (avgrabResults !== null) {
      const creditsCost = avgrabResults.length;

      billTeam(req.auth.team_id, creditsCost, req.acuc?.api_key_id ?? null, {
        endpoint: "map",
        jobId: mapId,
      }).catch(error => {
        logger.error(
          `Failed to bill team ${req.auth.team_id} for ${creditsCost} credits: ${error}`,
        );
      });

      logMap({
        id: mapId,
        request_id: mapId,
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
        results: avgrabResults,
        credits_cost: creditsCost,
        zeroDataRetention: false,
      }).catch(error => {
        logger.error(
          `Failed to log job for team ${req.auth.team_id}: ${error}`,
        );
      });

      return res.status(200).json({
        success: true,
        id: mapId,
        links: avgrabResults,
      });
    }
  } catch (error) {
    if (error instanceof MapFailedError) {
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
    logger.warn("avgrab resolve failed, falling back to standard map", {
      error,
    });
  }

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

  // Threat protection: remove blocked links from the returned URL list
  // entirely. Checks are URL-level; scan fees bill +2 per unique scanned
  // URL (see calculateThreatScanCredits).
  let threatScanCredits = 0;
  if (threatProtection.policy && result.mapResults.length > 0) {
    const { decisionsByUrl } = await checkUrlsAgainstThreatPolicy(
      result.mapResults.map(x => x.url),
      threatProtection.policy,
      { teamId: req.auth.team_id },
    );
    threatScanCredits = calculateThreatScanCredits(decisionsByUrl.values());
    result.mapResults = result.mapResults.filter(x => {
      const decision = decisionsByUrl.get(x.url);
      return decision === undefined || decision.allowed;
    });
  }

  // Bill the team
  const creditsToBill = 1 + threatScanCredits;
  billTeam(req.auth.team_id, creditsToBill, req.acuc?.api_key_id ?? null, {
    endpoint: "map",
    jobId: mapId,
  }).catch(error => {
    logger.error("Failed to bill team for map credits", {
      teamId: req.auth.team_id,
      creditsToBill,
      error,
    });
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
    credits_cost: creditsToBill,
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
    id: result.job_id,
    links: result.mapResults,
    ...(warning && { warning }),
  };

  return res.status(200).json(response);
}
