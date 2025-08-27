import { Logger } from "winston";
import { Meta } from "../..";
import {
  fireEngineScrape,
  FireEngineScrapeRequestChromeCDP,
  FireEngineScrapeRequestCommon,
  FireEngineScrapeRequestPlaywright,
  FireEngineScrapeRequestTLSClient,
} from "./scrape";
import { EngineScrapeResult } from "..";
import {
  fireEngineCheckStatus,
  FireEngineCheckStatusSuccess,
  StillProcessingError,
} from "./checkStatus";
import {
  ActionError,
  EngineError,
  DNSResolutionError,
  SiteError,
  SSLError,
  UnsupportedFileError,
  FEPageLoadFailed,
} from "../../error";
import * as Sentry from "@sentry/node";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import { fireEngineDelete } from "./delete";
import { MockState } from "../../lib/mock";
import { getInnerJSON } from "../../../../lib/html-transformer";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { Action } from "../../../../controllers/v1/types";
import { AbortManagerThrownError } from "../../lib/abortManager";

// This function does not take `Meta` on purpose. It may not access any
// meta values to construct the request -- that must be done by the
// `scrapeURLWithFireEngine*` functions.
async function performFireEngineScrape<
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
): Promise<FireEngineCheckStatusSuccess> {
  const scrape = await fireEngineScrape(
    logger.child({ method: "fireEngineScrape" }),
    request,
    mock,
    abort,
    production,
  );

  const errorLimit = 3;
  let errors: any[] = [];
  let status: FireEngineCheckStatusSuccess | undefined = undefined;

  while (status === undefined) {
    if (errors.length >= errorLimit) {
      logger.error("Error limit hit.", { errors });
      fireEngineDelete(
        logger.child({
          method: "performFireEngineScrape/fireEngineDelete",
          afterErrors: errors,
        }),
        scrape.jobId,
        mock,
        undefined,
        production,
      );
      throw new Error("Error limit hit. See e.cause.errors for errors.", {
        cause: { errors },
      });
    }

    meta.abort.throwIfAborted();

    try {
      status = await fireEngineCheckStatus(
        meta,
        logger.child({ method: "fireEngineCheckStatus" }),
        scrape.jobId,
        mock,
        abort,
        production,
      );
    } catch (error) {
      if (error instanceof StillProcessingError) {
        // nop
      } else if (
        error instanceof EngineError ||
        error instanceof SiteError ||
        error instanceof SSLError ||
        error instanceof DNSResolutionError ||
        error instanceof ActionError ||
        error instanceof UnsupportedFileError ||
        error instanceof FEPageLoadFailed
      ) {
        fireEngineDelete(
          logger.child({
            method: "performFireEngineScrape/fireEngineDelete",
            afterError: error,
          }),
          scrape.jobId,
          mock,
          undefined,
          production,
        );
        logger.debug("Fire-engine scrape job failed.", {
          error,
          jobId: scrape.jobId,
        });
        throw error;
      } else if (error instanceof AbortManagerThrownError) {
        fireEngineDelete(
          logger.child({
            method: "performFireEngineScrape/fireEngineDelete",
            afterError: error,
          }),
          scrape.jobId,
          mock,
          undefined,
          production,
        );
        throw error;
      } else {
        errors.push(error);
        logger.debug(
          `An unexpeceted error occurred while calling checkStatus. Error counter is now at ${errors.length}.`,
          { error, jobId: scrape.jobId },
        );
        Sentry.captureException(error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await specialtyScrapeCheck(
    logger.child({
      method: "performFireEngineScrape/specialtyScrapeCheck",
    }),
    status.responseHeaders,
    status,
  );

  const contentType = (Object.entries(status.responseHeaders ?? {}).find(
    (x) => x[0].toLowerCase() === "content-type",
  ) ?? [])[1] ?? "";

  if (contentType.includes("application/json")) {
    status.content = await getInnerJSON(status.content);
  }

  if (status.file) {
    const content = status.file.content;
    delete status.file;
    status.content = Buffer.from(content, "base64").toString("utf8"); // TODO: handle other encodings via Content-Type tag
  }

  fireEngineDelete(
    logger.child({
      method: "performFireEngineScrape/fireEngineDelete",
    }),
    scrape.jobId,
    mock,
    undefined,
    production,
  );

  return status;
}

export async function scrapeURLWithFireEngineChromeCDP(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const actions: Action[] = [
    // Transform waitFor option into an action (unsupported by chrome-cdp)
    ...(meta.options.waitFor !== 0
      ? [
          { 
            type: "wait" as const,
            milliseconds: meta.options.waitFor > 30000 ? 30000 : meta.options.waitFor,
          },
        ]
      : []),

    // Include specified actions
    ...(meta.options.actions ?? []),

    // Transform screenshot format into an action (unsupported by chrome-cdp)
    ...(hasFormatOfType(meta.options.formats, "screenshot")
      ? [
          {
            type: "screenshot" as const,
            fullPage: hasFormatOfType(meta.options.formats, "screenshot")?.fullPage || false,
            ...(hasFormatOfType(meta.options.formats, "screenshot")?.viewport ? 
              { viewport: hasFormatOfType(meta.options.formats, "screenshot")!.viewport } : {}),
          },
        ]
      : []),
  ];

  const totalWait = actions.reduce(
    (a, x) => (x.type === "wait" ? (x.milliseconds ?? 1000) + a : a),
    0,
  );

  const request: FireEngineScrapeRequestCommon &
    FireEngineScrapeRequestChromeCDP = {
    url: meta.rewrittenUrl ?? meta.url,
    engine: "chrome-cdp",
    instantReturn: true,
    skipTlsVerification: meta.options.skipTlsVerification,
    headers: meta.options.headers,
    ...(actions.length > 0
      ? {
          actions,
        }
      : {}),
    priority: meta.internalOptions.priority,
    geolocation: meta.options.location,
    mobile: meta.options.mobile,
    timeout: meta.abort.scrapeTimeout() ?? 300000,
    disableSmartWaitCache: meta.internalOptions.disableSmartWaitCache,
    mobileProxy: meta.featureFlags.has("stealthProxy"),
    saveScrapeResultToGCS: !meta.internalOptions.zeroDataRetention && meta.internalOptions.saveScrapeResultToGCS,
    zeroDataRetention: meta.internalOptions.zeroDataRetention,
  };

  let response = await performFireEngineScrape(
    meta,
    meta.logger.child({
      method: "scrapeURLWithFireEngineChromeCDP/callFireEngine",
      request,
    }),
    request,
    meta.mock,
    meta.abort.asSignal(),
    true,
  );

  if (hasFormatOfType(meta.options.formats, "screenshot")) {
    // meta.logger.debug(
    //   "Transforming screenshots from actions into screenshot field",
    //   { screenshots: response.screenshots },
    // );
    if (response.screenshots) {
      response.screenshot = response.screenshots.slice(-1)[0];
      response.screenshots = response.screenshots.slice(0, -1);
    }
    // meta.logger.debug("Screenshot transformation done", {
    //   screenshots: response.screenshots,
    //   screenshot: response.screenshot,
    // });
  }

  if (!response.url) {
    meta.logger.warn("Fire-engine did not return the response's URL", {
      response,
      sourceURL: meta.url,
    });
  }

  return {
    url: response.url ?? meta.url,

    html: response.content,
    error: response.pageError,
    statusCode: response.pageStatusCode,

    contentType: (Object.entries(response.responseHeaders ?? {}).find(
      (x) => x[0].toLowerCase() === "content-type",
    ) ?? [])[1] ?? undefined,

    screenshot: response.screenshot,
    ...(actions.length > 0
      ? {
          actions: {
            screenshots: response.screenshots ?? [],
            scrapes: response.actionContent ?? [],
            javascriptReturns: (response.actionResults ?? []).filter(x => x.type === "executeJavascript").map(x => JSON.parse((x.result as any as { return: string }).return)),
            pdfs: (response.actionResults ?? []).filter(x => x.type === "pdf").map(x => x.result.link),
          },
        }
      : {}),

    proxyUsed: response.usedMobileProxy ? "stealth" : "basic",
  };
}

export async function scrapeURLWithFireEnginePlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const totalWait = meta.options.waitFor;

  const request: FireEngineScrapeRequestCommon &
    FireEngineScrapeRequestPlaywright = {
    url: meta.rewrittenUrl ?? meta.url,
    engine: "playwright",
    instantReturn: true,

    headers: meta.options.headers,
    priority: meta.internalOptions.priority,
    screenshot: hasFormatOfType(meta.options.formats, "screenshot") !== undefined,
    fullPageScreenshot: hasFormatOfType(meta.options.formats, "screenshot")?.fullPage,
    wait: meta.options.waitFor,
    geolocation: meta.options.location,
    blockAds: meta.options.blockAds,
    mobileProxy: meta.featureFlags.has("stealthProxy"),

    timeout: meta.abort.scrapeTimeout() ?? 300000,
    saveScrapeResultToGCS: !meta.internalOptions.zeroDataRetention && meta.internalOptions.saveScrapeResultToGCS,
    zeroDataRetention: meta.internalOptions.zeroDataRetention,
  };

  let response = await performFireEngineScrape(
    meta,
    meta.logger.child({
      method: "scrapeURLWithFireEnginePlaywright/callFireEngine",
      request,
    }),
    request,
    meta.mock,
    meta.abort.asSignal(),
  );

  if (!response.url) {
    meta.logger.warn("Fire-engine did not return the response's URL", {
      response,
      sourceURL: meta.url,
    });
  }

  return {
    url: response.url ?? meta.url,

    html: response.content,
    error: response.pageError,
    statusCode: response.pageStatusCode,

    contentType: (Object.entries(response.responseHeaders ?? {}).find(
      (x) => x[0].toLowerCase() === "content-type",
    ) ?? [])[1] ?? undefined,

    ...(response.screenshots !== undefined && response.screenshots.length > 0
      ? {
          screenshot: response.screenshots[0],
        }
      : {}),

    proxyUsed: response.usedMobileProxy ? "stealth" : "basic",
  };
}

export async function scrapeURLWithFireEngineTLSClient(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const request: FireEngineScrapeRequestCommon &
    FireEngineScrapeRequestTLSClient = {
    url: meta.rewrittenUrl ?? meta.url,
    engine: "tlsclient",
    instantReturn: true,

    headers: meta.options.headers,
    priority: meta.internalOptions.priority,

    atsv: meta.internalOptions.atsv,
    geolocation: meta.options.location,
    disableJsDom: meta.internalOptions.v0DisableJsDom,
    mobileProxy: meta.featureFlags.has("stealthProxy"),

    timeout: meta.abort.scrapeTimeout() ?? 300000,
    saveScrapeResultToGCS: !meta.internalOptions.zeroDataRetention && meta.internalOptions.saveScrapeResultToGCS,
    zeroDataRetention: meta.internalOptions.zeroDataRetention,
  };

  let response = await performFireEngineScrape(
    meta,
    meta.logger.child({
      method: "scrapeURLWithFireEngineTLSClient/callFireEngine",
      request,
    }),
    request,
    meta.mock,
    meta.abort.asSignal(),
  );

  if (!response.url) {
    meta.logger.warn("Fire-engine did not return the response's URL", {
      response,
      sourceURL: meta.url,
    });
  }

  return {
    url: response.url ?? meta.url,

    html: response.content,
    error: response.pageError,
    statusCode: response.pageStatusCode,

    contentType: (Object.entries(response.responseHeaders ?? {}).find(
      (x) => x[0].toLowerCase() === "content-type",
    ) ?? [])[1] ?? undefined,

    proxyUsed: response.usedMobileProxy ? "stealth" : "basic",
  };
}

export function fireEngineMaxReasonableTime(meta: Meta, engine: "chrome-cdp" | "playwright" | "tlsclient"): number {
  if (engine === "tlsclient") {
    return 15000;
  } else if (engine === "playwright") {
    return (meta.options.waitFor ?? 0) + 30000;
  } else {
    return (meta.options.waitFor ?? 0)
      + (meta.options.actions?.reduce(
          (a, x) => (x.type === "wait" ? (x.milliseconds ?? 2500) + a : 250 + a),
          0
        ) ?? 0)
      + 30000;
  }
}
