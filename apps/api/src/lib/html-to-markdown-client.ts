/**
 * HTTP Client for HTML to Markdown conversion service
 *
 * This client communicates with the Go-based HTML to Markdown microservice
 * to avoid blocking Node.js event loop with heavy conversions.
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import { logger } from "./logger";
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
  success: boolean;
}

/**
 * Convert HTML to Markdown using direct axios call
 * @param html HTML string to convert
 * @param serviceUrl URL of the HTML to Markdown service (default: http://localhost:8080)
 * @returns Markdown string
 * @throws Error if conversion fails
 */
export async function convertHTMLToMarkdownWithHttpService(
  html: string,
  serviceUrl?: string,
): Promise<string> {
  if (!html || html.trim() === "") {
    return "";
  }

  const url =
    serviceUrl ||
    process.env.HTML_TO_MARKDOWN_SERVICE_URL ||
    "http://localhost:8080";
  const startTime = Date.now();

  try {
    const request: ConvertRequest = { html };

    const response = await axios.post<ConvertResponse>(
      `${url}/convert`,
      request,
      {
        timeout: 30000, // 30 second timeout
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    const duration = Date.now() - startTime;

    if (!response.data.success) {
      throw new Error("Conversion was not successful");
    }

    logger.debug("HTML to Markdown conversion successful", {
      duration_ms: duration,
      input_size: html.length,
      output_size: response.data.markdown.length,
    });

    return response.data.markdown;
  } catch (error) {
    const duration = Date.now() - startTime;

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<ErrorResponse>;

      const errorMessage =
        axiosError.response?.data?.error || axiosError.message;
      const statusCode = axiosError.response?.status;

      logger.error("HTML to Markdown conversion failed", {
        error: errorMessage,
        statusCode,
        duration_ms: duration,
        serviceUrl: url,
      });

      // Capture in Sentry with additional context
      Sentry.captureException(error, {
        tags: {
          service: "html-to-markdown",
          status_code: statusCode,
        },
        extra: {
          serviceUrl: url,
          errorMessage,
          inputSize: html.length,
        },
      });

      throw new Error(`HTML to Markdown conversion failed: ${errorMessage}`);
    } else {
      logger.error("Unexpected error during HTML to Markdown conversion", {
        error,
      });
      Sentry.captureException(error);
      throw error;
    }
  }
}
