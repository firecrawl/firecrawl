/**
 * HTTP Client for HTML to Markdown conversion service
 *
 * This client communicates with the Go-based HTML to Markdown microservice
 * to avoid blocking Node.js event loop with heavy conversions.
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import { config } from "../config";
import { logger } from "./logger";
import type { Logger } from "winston";
import * as Sentry from "@sentry/node";

interface ConvertRequest {
  html: string;
}

interface ConvertResponse {
  markdown: string;
  success: boolean;
}

interface ErrorResponse {
  error: string;
  details?: string;
  success: boolean;
}

/**
 * Convert HTML to Markdown using direct axios call
 * @param html HTML string to convert
 * @param context Optional context with logger and requestId
 * @returns Markdown string
 * @throws Error if conversion fails
 */
export async function convertHTMLToMarkdownWithHttpService(
  html: string,
  context?: {
    logger?: Logger;
    requestId?: string;
    zeroDataRetention?: boolean;
  },
): Promise<string> {
  if (!html || html.trim() === "") {
    return "";
  }

  const contextLogger = context?.logger || logger;
  const requestId = context?.requestId;
  const zeroDataRetention = context?.zeroDataRetention === true;
  const url = config.HTML_TO_MARKDOWN_SERVICE_URL;
  const startTime = Date.now();

  try {
    const request: ConvertRequest = { html };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Add request ID header if available, but never for ZDR — it would
    // let the downstream service correlate logs back to a customer scrape.
    if (requestId && !zeroDataRetention) {
      headers["X-Request-ID"] = requestId;
    }

    if (zeroDataRetention) {
      headers["X-Zero-Data-Retention"] = "true";
    }

    const response = await axios.post<ConvertResponse>(
      `${url}/convert`,
      request,
      {
        timeout: 60_000,
        headers,
      },
    );

    const duration = Date.now() - startTime;

    if (!response.data.success) {
      throw new Error("Conversion was not successful");
    }

    if (!zeroDataRetention) {
      contextLogger.debug("HTML to Markdown conversion successful", {
        duration_ms: duration,
        input_size: html.length,
        output_size: response.data.markdown.length,
        ...(requestId ? { request_id: requestId } : {}),
      });
    }

    return response.data.markdown;
  } catch (error) {
    const duration = Date.now() - startTime;

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<ErrorResponse>;

      const errorMessage =
        axiosError.response?.data?.error || axiosError.message;
      const errorDetails = axiosError.response?.data?.details;
      const statusCode = axiosError.response?.status;

      contextLogger.error("HTML to Markdown conversion failed", {
        error: errorMessage,
        details: errorDetails,
        statusCode,
        duration_ms: duration,
        serviceUrl: url,
      });

      // Capture in Sentry with additional context (omit identifying fields
      // and content sizes when ZDR so nothing is retained in Sentry either).
      Sentry.captureException(error, {
        tags: {
          service: "html-to-markdown",
          status_code: statusCode,
          ...(requestId && !zeroDataRetention ? { request_id: requestId } : {}),
        },
        extra: {
          serviceUrl: url,
          errorMessage,
          errorDetails,
          ...(zeroDataRetention ? {} : { inputSize: html.length }),
        },
      });

      // Include details in error message if available
      const fullErrorMessage = errorDetails
        ? `HTML to Markdown conversion failed: ${errorMessage} - ${errorDetails}`
        : `HTML to Markdown conversion failed: ${errorMessage}`;

      throw new Error(fullErrorMessage);
    } else {
      contextLogger.error(
        "Unexpected error during HTML to Markdown conversion",
        {
          error,
        },
      );
      Sentry.captureException(error, {
        tags: {
          ...(requestId && !zeroDataRetention ? { request_id: requestId } : {}),
        },
      });
      throw error;
    }
  }
}
