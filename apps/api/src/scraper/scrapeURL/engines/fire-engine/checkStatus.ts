import { Logger } from "winston";
import * as Sentry from "@sentry/node";
import { z } from "zod";

import { robustFetch } from "../../lib/fetch";
import {
  ActionError,
  EngineError,
  SiteError,
  SSLError,
  UnsupportedFileError,
  DNSResolutionError,
  FEPageLoadFailed,
  ProxySelectionError,
} from "../../error";
import { MockState } from "../../lib/mock";
import { fireEngineStagingURL, fireEngineURL } from "./scrape";
import { getDocFromGCS } from "../../../../lib/gcs-jobs";
import { Meta } from "../..";

const successSchema = z.object({
  jobId: z.string(),
  state: z.literal("completed"),
  processing: z.literal(false),

  // timeTaken: z.number(),
  content: z.string(),
  url: z.string().optional(),

  pageStatusCode: z.number(),
  pageError: z.string().optional(),

  // TODO: this needs to be non-optional, might need fixes on f-e side to ensure reliability
  responseHeaders: z.record(z.string(), z.string()).optional(),

  // timeTakenCookie: z.number().optional(),
  // timeTakenRequest: z.number().optional(),

  // legacy: playwright only
  screenshot: z.string().optional(),

  // new: actions
  screenshots: z.string().array().optional(),
  actionContent: z
    .object({
      url: z.string(),
      html: z.string(),
    })
    .array()
    .optional(),
  actionResults: z
    .union([
      z.object({
        idx: z.number(),
        type: z.literal("screenshot"),
        result: z.object({
          path: z.string(),
        }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("scrape"),
        result: z.union([
          z.object({
            url: z.string(),
            html: z.string(),
          }),
          z.object({
            url: z.string(),
            accessibility: z.string(),
          }),
        ]),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("executeJavascript"),
        result: z.object({
          return: z.string(),
        }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("pdf"),
        result: z.object({
          link: z.string(),
        }),
      }),
    ])
    .array()
    .optional(),

  // chrome-cdp only -- file download handler
  file: z
    .object({
      name: z.string(),
      content: z.string(),
    })
    .optional()
    .or(z.null()),

  docUrl: z.string().optional(),

  usedMobileProxy: z.boolean().optional(),
  youtubeTranscriptContent: z.any().optional(),
});

export type FireEngineCheckStatusSuccess = z.infer<typeof successSchema>;

const processingSchema = z.object({
  jobId: z.string(),
  state: z.enum([
    "delayed",
    "active",
    "waiting",
    "waiting-children",
    "unknown",
    "prioritized",
    "pending",
  ]),
  processing: z.boolean(),
});

const failedSchema = z.object({
  jobId: z.string(),
  state: z.literal("failed"),
  processing: z.literal(false),
  error: z.string(),
});

export class StillProcessingError extends Error {
  constructor(jobId: string) {
    super("Job is still under processing", { cause: { jobId } });
  }
}

export async function fireEngineCheckStatus(
  meta: Meta,
  logger: Logger,
  jobId: string,
  mock: MockState | null,
  abort?: AbortSignal,
  production = true,
): Promise<FireEngineCheckStatusSuccess> {
  let status = await robustFetch({
    url: `${production ? fireEngineURL : fireEngineStagingURL}/scrape/${jobId}`,
    method: "GET",
    logger: logger.child({ method: "fireEngineCheckStatus/robustFetch" }),
    headers: {},
    mock,
    abort,
  });

  // Fire-engine now saves the content to GCS
  if (!status.content && status.docUrl) {
    const doc = await getDocFromGCS(status.docUrl.split("/").pop() ?? "");
    if (doc) {
      status = { ...status, ...doc };
      delete status.docUrl;
    }
  }

  const successParse = successSchema.safeParse(status);
  const processingParse = processingSchema.safeParse(status);
  const failedParse = failedSchema.safeParse(status);

  if (successParse.success) {
    logger.debug("Scrape succeeded!", { jobId });
    return successParse.data;
  } else if (processingParse.success) {
    throw new StillProcessingError(jobId);
  } else if (failedParse.success) {
    logger.debug("Scrape job failed", { status, jobId });
    if (
      typeof status.error === "string" &&
      status.error.includes("Chrome error: ")
    ) {
      const code = status.error.split("Chrome error: ")[1];

      if (
        code.includes("ERR_CERT_") ||
        code.includes("ERR_SSL_") ||
        code.includes("ERR_BAD_SSL_")
      ) {
        throw new SSLError(meta.options.skipTlsVerification);
      } else {
        throw new SiteError(code);
      }
    } else if (
      typeof status.error === "string" &&
      status.error.includes("proxies available for")
    ) {
      throw new ProxySelectionError();
    } else if (
      typeof status.error === "string" &&
      status.error.includes("Dns resolution error for hostname: ")
    ) {
      throw new DNSResolutionError(
        status.error.split("Dns resolution error for hostname: ")[1],
      );
    } else if (
      typeof status.error === "string" &&
      status.error.includes("File size exceeds")
    ) {
      throw new UnsupportedFileError(
        "File size exceeds " + status.error.split("File size exceeds ")[1],
      );
    } else if (
      typeof status.error === "string" &&
      status.error.includes("failed to finish without timing out")
    ) {
      logger.warn("CDP timed out while loading the page", { status, jobId });
      throw new FEPageLoadFailed();
    } else if (
      typeof status.error === "string" &&
      // TODO: improve this later
      (status.error.includes("Element") ||
        status.error.includes("Javascript execution failed"))
    ) {
      const errorMessage = status.error.startsWith("Error: ")
        ? status.error.substring(7)
        : status.error;
      throw new ActionError(errorMessage);
    } else {
      throw new EngineError("Scrape job failed", {
        cause: {
          status,
          jobId,
        },
      });
    }
  } else {
    logger.debug("Check status returned response not matched by any schema", {
      status,
      jobId,
    });
    throw new Error(
      "Check status returned response not matched by any schema",
      {
        cause: {
          status,
          jobId,
        },
      },
    );
  }
}
