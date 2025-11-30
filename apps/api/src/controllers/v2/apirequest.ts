import { Response } from "express";
import { logger as _logger } from "../../lib/logger";
import {
  ApiRequest,
  ApiRequestDocument,
  ApiRequestInput,
  ApiRequestResponse,
  HttpMethod,
  RequestWithAuth,
  apiRequestSchema,
} from "./types";
import { v7 as uuidv7 } from "uuid";
import { TransportableError } from "../../lib/error";
import { withSpan, setSpanAttributes, SpanKind } from "../../lib/otel-tracer";
import { teamConcurrencySemaphore } from "../../services/worker/team-semaphore";
import * as undici from "undici";
import { getSecureDispatcher } from "../../scraper/scrapeURL/engines/utils/safeFetch";

async function executeApiRequest(
  url: string,
  method: HttpMethod,
  options: {
    body?: string | Record<string, any>;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    timeout: number;
    skipTlsVerification?: boolean;
  },
  abort: AbortSignal,
): Promise<ApiRequestDocument> {
  const startTime = Date.now();

  // Build URL with query parameters
  const urlObj = new URL(url);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      urlObj.searchParams.append(key, value);
    }
  }
  const finalUrl = urlObj.toString();

  // Prepare request body
  let requestBody: string | undefined;
  const requestHeaders: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) {
    if (typeof options.body === "string") {
      requestBody = options.body;
    } else {
      requestBody = JSON.stringify(options.body);
      // Set content-type if not already set
      if (
        !Object.keys(requestHeaders).some(
          k => k.toLowerCase() === "content-type",
        )
      ) {
        requestHeaders["Content-Type"] = "application/json";
      }
    }
  }

  // Create abort signal with timeout
  const timeoutSignal = AbortSignal.timeout(options.timeout);
  const combinedSignal = AbortSignal.any([abort, timeoutSignal]);

  const response = await undici.fetch(finalUrl, {
    method,
    headers: requestHeaders,
    body: requestBody,
    dispatcher: getSecureDispatcher(options.skipTlsVerification ?? false),
    redirect: "follow",
    signal: combinedSignal,
  });

  const responseBody = await response.text();
  const endTime = Date.now();

  // Convert headers to Record<string, string>
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: responseBody,
    url: response.url,
    timing: {
      total: endTime - startTime,
    },
    metadata: {
      sourceURL: url,
      method,
      contentType: responseHeaders["content-type"],
    },
  };
}

export async function apiRequestController(
  req: RequestWithAuth<{}, ApiRequestResponse, ApiRequestInput>,
  res: Response<ApiRequestResponse>,
) {
  return withSpan(
    "api.apirequest.request",
    async span => {
      const middlewareStartTime =
        (req as any).requestTiming?.startTime || new Date().getTime();
      const controllerStartTime = new Date().getTime();

      const jobId = uuidv7();
      const preNormalizedBody = { ...req.body };

      setSpanAttributes(span, {
        "apirequest.job_id": jobId,
        "apirequest.url": String(req.body?.url ?? ""),
        "apirequest.method": String(req.body?.method ?? "GET"),
        "apirequest.team_id": req.auth.team_id,
        "apirequest.api_key_id": req.acuc?.api_key_id,
        "apirequest.middleware_time_ms": controllerStartTime - middlewareStartTime,
      });

      // Validation
      let validatedBody: ApiRequest;
      try {
        validatedBody = apiRequestSchema.parse(req.body);
      } catch (error) {
        setSpanAttributes(span, {
          "apirequest.error": "Validation failed",
          "apirequest.status_code": 400,
        });
        return res.status(400).json({
          success: false,
          error:
            error instanceof Error ? error.message : "Invalid request body",
          details: error,
        });
      }

      const zeroDataRetention =
        req.acuc?.flags?.forceZDR || validatedBody.zeroDataRetention;

      const logger = _logger.child({
        method: "apiRequestController",
        jobId,
        noq: true,
        requestId: jobId,
        teamId: req.auth.team_id,
        team_id: req.auth.team_id,
        zeroDataRetention,
      });

      const middlewareTime = controllerStartTime - middlewareStartTime;

      logger.debug("API Request " + jobId + " starting", {
        version: "v2",
        requestId: jobId,
        request: validatedBody,
        originalRequest: preNormalizedBody,
        account: req.account,
      });

      setSpanAttributes(span, {
        "apirequest.zero_data_retention": zeroDataRetention,
        "apirequest.origin": validatedBody.origin,
        "apirequest.timeout": validatedBody.timeout,
      });

      const timeout = validatedBody.timeout;

      let doc: ApiRequestDocument | null = null;
      let timeoutHandle: NodeJS.Timeout | null = null;

      try {
        const lockStart = Date.now();
        const aborter = new AbortController();

        if (timeout) {
          timeoutHandle = setTimeout(() => {
            aborter.abort();
          }, timeout * 0.667);
        }
        req.on("close", () => aborter.abort());

        doc = await teamConcurrencySemaphore.withSemaphore(
          req.auth.team_id,
          jobId,
          req.acuc?.concurrency || 1,
          aborter.signal,
          timeout ?? 30000,
          async limited => {
            const lockTime = Date.now() - lockStart;

            logger.debug(`Lock acquired for team: ${req.auth.team_id}`, {
              teamId: req.auth.team_id,
              lockTime,
            });

            const result = await withSpan(
              "api.apirequest.execute",
              async executeSpan => {
                setSpanAttributes(executeSpan, {
                  "execute.timeout": timeout,
                  "execute.job_id": jobId,
                  "execute.method": validatedBody.method,
                });

                const doc = await executeApiRequest(
                  validatedBody.url,
                  validatedBody.method,
                  {
                    body: validatedBody.body,
                    headers: validatedBody.headers,
                    params: validatedBody.params,
                    timeout: timeout,
                    skipTlsVerification: validatedBody.skipTlsVerification,
                  },
                  aborter.signal,
                );

                setSpanAttributes(executeSpan, {
                  "execute.success": true,
                  "execute.status_code": doc.statusCode,
                });

                return doc;
              },
            );

            return result;
          },
        );
      } catch (e) {
        const isTimeout =
          e instanceof Error &&
          (e.name === "TimeoutError" || e.message.includes("timed out"));

        if (!isTimeout) {
          logger.error(`Error in apiRequestController`, {
            version: "v2",
            error: e,
          });
        }

        setSpanAttributes(span, {
          "apirequest.error": e instanceof Error ? e.message : String(e),
          "apirequest.error_type": isTimeout ? "timeout" : "unknown",
        });

        if (isTimeout) {
          setSpanAttributes(span, {
            "apirequest.status_code": 408,
          });
          return res.status(408).json({
            success: false,
            error: "Request timed out",
          });
        }

        if (e instanceof TransportableError) {
          const statusCode = 500;
          setSpanAttributes(span, {
            "apirequest.status_code": statusCode,
          });
          return res.status(statusCode).json({
            success: false,
            code: e.code,
            error: e.message,
          });
        }

        // Check for connection security error (private IP)
        if (
          e instanceof TypeError &&
          e.message.includes("fetch failed") &&
          e.cause instanceof Error &&
          e.cause.message.includes("security")
        ) {
          setSpanAttributes(span, {
            "apirequest.status_code": 403,
          });
          return res.status(403).json({
            success: false,
            error:
              "Request blocked: Cannot make requests to private/internal IP addresses",
          });
        }

        setSpanAttributes(span, {
          "apirequest.status_code": 500,
        });
        return res.status(500).json({
          success: false,
          error: `(Internal server error) - ${e && (e as Error).message ? (e as Error).message : e}`,
        });
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      const totalRequestTime = new Date().getTime() - middlewareStartTime;
      const controllerTime = new Date().getTime() - controllerStartTime;

      setSpanAttributes(span, {
        "apirequest.success": true,
        "apirequest.status_code": 200,
        "apirequest.total_request_time_ms": totalRequestTime,
        "apirequest.controller_time_ms": controllerTime,
        "apirequest.response_status_code": doc?.statusCode,
        "apirequest.response_content_type": doc?.metadata?.contentType,
      });

      logger.info("Request metrics", {
        version: "v2",
        requestId: jobId,
        mode: "apirequest",
        middlewareStartTime,
        controllerStartTime,
        middlewareTime,
        controllerTime,
        totalRequestTime,
        method: validatedBody.method,
        responseStatusCode: doc?.statusCode,
      });

      return res.status(200).json({
        success: true,
        data: doc!,
        request_id: validatedBody.origin?.includes("website")
          ? jobId
          : undefined,
      });
    },
    {
      attributes: {
        "http.method": "POST",
        "http.route": "/v2/apirequest",
      },
      kind: SpanKind.SERVER,
    },
  );
}
