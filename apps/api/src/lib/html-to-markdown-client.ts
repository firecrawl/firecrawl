/**
 * HTTP Client for HTML to Markdown conversion service
 *
 * This client communicates with the Go-based HTML to Markdown microservice
 * to avoid blocking Node.js event loop with heavy conversions.
 */

import axios from "axios";
import type { Logger } from "winston";
import { config } from "../config";
import type { LogMeta } from "./json-types";
import { logger } from "./logger";

interface ConvertRequest {
  html: string;
}

type ConvertRequestHeaders = {
  "Content-Type": string;
  "X-Request-ID"?: string;
  "X-Zero-Data-Retention"?: string;
};

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

  let failureMessage: string;
  try {
    const request: ConvertRequest = { html };

    const headers: ConvertRequestHeaders = {
      "Content-Type": "application/json",
    };

    // Add request ID header if available, but never for ZDR, so the
    // downstream service cannot correlate logs back to a customer scrape.
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
      const debugMeta: LogMeta = {
        duration_ms: duration,
        input_size: html.length,
        output_size: response.data.markdown.length,
      };
      if (requestId) {
        debugMeta.request_id = requestId;
      }
      contextLogger.debug("HTML to Markdown conversion successful", debugMeta);
    }

    return response.data.markdown;
  } catch (error: unknown) {
    const duration = Date.now() - startTime;

    if (axios.isAxiosError<ErrorResponse>(error)) {
      const errorMessage = error.response?.data?.error || error.message;
      const errorDetails = error.response?.data?.details;
      const statusCode = error.response?.status;

      contextLogger.error("HTML to Markdown conversion failed", {
        error: errorMessage,
        details: errorDetails,
        statusCode,
        duration_ms: duration,
        serviceUrl: url,
      });

      // Include details in error message if available
      failureMessage = errorDetails
        ? `HTML to Markdown conversion failed: ${errorMessage} - ${errorDetails}`
        : `HTML to Markdown conversion failed: ${errorMessage}`;
    } else {
      contextLogger.error(
        "Unexpected error during HTML to Markdown conversion",
        {
          error,
        },
      );
      throw error;
    }
  }

  throw new Error(failureMessage);
}
