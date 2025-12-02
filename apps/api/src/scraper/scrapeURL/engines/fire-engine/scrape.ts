import { Logger } from "winston";
import * as Sentry from "@sentry/node";
import { z } from "zod";

import { Action } from "../../../../controllers/v1/types";
import { robustFetch } from "../../lib/fetch";
import { MockState } from "../../lib/mock";
import { getDocFromGCS } from "../../../../lib/gcs-jobs";
import {
  ActionError,
  DNSResolutionError,
  EngineError,
  FEPageLoadFailed,
  ProxySelectionError,
  SSLError,
  SiteError,
  UnsupportedFileError,
} from "../../error";
import { Meta } from "../..";
import { abTestFireEngine } from "../../../../services/ab-test";

export type FireEngineScrapeRequestCommon = {
  url: string;

  headers?: { [K: string]: string };

  blockMedia?: boolean; // default: true
  // pageOptions?: any; // unused, .scrollXPaths is considered on FE side

  // useProxy?: boolean; // unused, default: true
  // customProxy?: string; // unused

  // disableSmartWaitCache?: boolean; // unused, default: false
  // skipDnsCheck?: boolean; // unused, default: false

  priority?: number; // default: 1
  // team_id?: string; // unused
  logRequest?: boolean; // default: true
  instantReturn?: boolean; // default: false
  geolocation?: { country?: string; languages?: string[] };

  mobileProxy?: boolean; // leave it undefined if user doesn't specify

  timeout?: number;
  saveScrapeResultToGCS?: boolean;
  zeroDataRetention?: boolean;
};

export type FireEngineScrapeRequestChromeCDP = {
  engine: "chrome-cdp";
  skipTlsVerification?: boolean;
  actions?: Action[];
  blockMedia?: boolean;
  mobile?: boolean;
  disableSmartWaitCache?: boolean;
};

export type FireEngineScrapeRequestPlaywright = {
  engine: "playwright";
  blockAds?: boolean; // default: true

  // mutually exclusive, default: false
  screenshot?: boolean;
  fullPageScreenshot?: boolean;

  wait?: number; // default: 0
};

export type FireEngineScrapeRequestTLSClient = {
  engine: "tlsclient";
  atsv?: boolean; // v0 only, default: false
  disableJsDom?: boolean; // v0 only, default: false
};

const successSchema = z.object({
  jobId: z.string().optional(), // only defined if we are deferring deletion

  timeTaken: z.number(),
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

type FireEngineCheckStatusSuccess = z.infer<typeof successSchema>;

const processingSchema = z.object({
  jobId: z.string(),
  processing: z.boolean(),
});

const failedSchema = z.object({
  error: z.string(),
});

export const fireEngineURL =
  process.env.FIRE_ENGINE_BETA_URL ?? "<mock-fire-engine-url>";
export const fireEngineStagingURL =
  process.env.FIRE_ENGINE_STAGING_URL ?? "<mock-fire-engine-url>";

export async function fireEngineScrape<
  Engine extends
    | FireEngineScrapeRequestChromeCDP
    | FireEngineScrapeRequestPlaywright
    | FireEngineScrapeRequestTLSClient,
>(
  meta: Meta,
  logger: Logger,
  request: FireEngineScrapeRequestCommon & Engine,
  mock: MockState | null,
  abort?: AbortSignal,
  production = true,
): Promise<z.infer<typeof processingSchema> | FireEngineCheckStatusSuccess> {
  abTestFireEngine(request);

  let status = await robustFetch({
    url: `${production ? fireEngineURL : fireEngineStagingURL}/scrape`,
    method: "POST",
    headers: {},
    body: request,
    logger: logger.child({ method: "fireEngineScrape/robustFetch" }),
    tryCount: 3,
    ignoreFailureStatus: true, // sends 500 on processing and various codes on errors
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
    logger.debug("Scrape succeeded!");
    return successParse.data;
  } else if (processingParse.success) {
    return processingParse.data;
  } else if (failedParse.success) {
    logger.debug("Scrape job failed", {
      status,
    });
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
      logger.warn("CDP timed out while loading the page", {
        status,
      });
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
    } else if (
      typeof status.error === "string" &&
      status.error.includes("proxies available for")
    ) {
      throw new ProxySelectionError();
    } else {
      throw new EngineError("Scrape job failed", {
        cause: {
          status,
        },
      });
    }
  } else {
    logger.debug("Scrape returned response not matched by any schema", {
      status,
    });
    throw new Error(
      "Check status returned response not matched by any schema",
      {
        cause: {
          status,
        },
      },
    );
  }
}
