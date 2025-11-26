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
  ProxySelectionError,
} from "../../error";
import * as Sentry from "@sentry/node";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import { fireEngineDelete } from "./delete";
import { MockState } from "../../lib/mock";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { Action } from "../../../../controllers/v1/types";
import { AbortManagerThrownError } from "../../lib/abortManager";
import { youtubePostprocessor } from "../../postprocessors/youtube";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { getBrandingScript } from "./brandingScript";

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
  return withSpan("engine.fire-engine.perform_scrape", async span => {
    const startTime = Date.now();
    let pollCount = 0;

    setSpanAttributes(span, {
      "fire-engine.url": request.url,
      "fire-engine.priority": request.priority,
      "fire-engine.wait": (request as any).wait,
      "fire-engine.screenshot": (request as any).screenshot,
      "fire-engine.fullpage": (request as any).fullPage,
      "fire-engine.proxy": (request as any).proxy,
      "fire-engine.mobile": (request as any).mobile,
      "fire-engine.skip_tls": (request as any).skipTlsVerification,
      "fire-engine.production": production,
    });
    const scrape = await fireEngineScrape(
      meta,
      logger.child({ method: "fireEngineScrape" }),
      request,
      mock,
      abort,
      production,
    );

    let status: FireEngineCheckStatusSuccess | undefined = undefined;
    if ((scrape as any).processing) {
      const errorLimit = 3;
      let errors: any[] = [];

      while (status === undefined) {
        if (errors.length >= errorLimit) {
          logger.error("Error limit hit.", { errors });
          fireEngineDelete(
            logger.child({
              method: "performFireEngineScrape/fireEngineDelete",
              afterErrors: errors,
            }),
            (scrape as any).jobId,
            mock,
            undefined,
            production,
          ).catch(e => {
            logger.error("Failed to delete job from Fire Engine", { error: e });
          });
          throw new Error("Error limit hit. See e.cause.errors for errors.", {
            cause: { errors },
          });
        }

        meta.abort.throwIfAborted();

        try {
          pollCount++;
          status = await fireEngineCheckStatus(
            meta,
            logger.child({ method: "fireEngineCheckStatus" }),
            (scrape as any).jobId,
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
            error instanceof FEPageLoadFailed ||
            error instanceof ProxySelectionError
          ) {
            fireEngineDelete(
              logger.child({
                method: "performFireEngineScrape/fireEngineDelete",
                afterError: error,
              }),
              (scrape as any).jobId,
              mock,
              undefined,
              production,
            ).catch(e => {
              logger.error("Failed to delete job from Fire Engine", {
                error: e,
              });
            });
            logger.debug("Fire-engine scrape job failed.", {
              error,
              jobId: (scrape as any).jobId,
            });
            throw error;
          } else if (error instanceof AbortManagerThrownError) {
            fireEngineDelete(
              logger.child({
                method: "performFireEngineScrape/fireEngineDelete",
                afterError: error,
              }),
              (scrape as any).jobId,
              mock,
              undefined,
              production,
            ).catch(e => {
              logger.error("Failed to delete job from Fire Engine", {
                error: e,
              });
            });
            throw error;
          } else {
            errors.push(error);
            logger.debug(
              `An unexpeceted error occurred while calling checkStatus. Error counter is now at ${errors.length}.`,
              { error, jobId: (scrape as any).jobId },
            );
            Sentry.captureException(error);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      status = scrape as FireEngineCheckStatusSuccess;
    }

    await specialtyScrapeCheck(
      logger.child({
        method: "performFireEngineScrape/specialtyScrapeCheck",
      }),
      status.responseHeaders,
      status,
    );

    const contentType =
      (Object.entries(status.responseHeaders ?? {}).find(
        x => x[0].toLowerCase() === "content-type",
      ) ?? [])[1] ?? "";

    if (contentType.includes("application/json")) {
      status.content = await getInnerJson(status.content);
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
      (scrape as any).jobId,
      mock,
      undefined,
      production,
    ).catch(e => {
      logger.error("Failed to delete job from Fire Engine", { error: e });
    });

    setSpanAttributes(span, {
      "fire-engine.poll_count": pollCount,
      "fire-engine.duration_ms": Date.now() - startTime,
      "fire-engine.status_code": status.pageStatusCode,
      "fire-engine.content_length": status.content?.length,
      "fire-engine.has_screenshot": !!status.screenshot,
      "fire-engine.has_pdf": !!(status as any).pdf,
      "fire-engine.job_id": (scrape as any).jobId,
    });

    return status;
  });
}

export async function scrapeURLWithFireEngineChromeCDP(
  meta: Meta,
): Promise<EngineScrapeResult> {
  return withSpan("engine.fire-engine.chrome-cdp", async span => {
    setSpanAttributes(span, {
      "engine.type": "fire-engine-chrome-cdp",
      "engine.url": meta.url,
      "engine.team_id": meta.internalOptions.teamId,
    });
    const actions: Action[] = [
      // Transform waitFor option into an action (unsupported by chrome-cdp)
      ...(meta.options.waitFor !== 0
        ? [
            {
              type: "wait" as const,
              milliseconds:
                meta.options.waitFor > 30000 ? 30000 : meta.options.waitFor,
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
              fullPage:
                hasFormatOfType(meta.options.formats, "screenshot")?.fullPage ||
                false,
              ...(hasFormatOfType(meta.options.formats, "screenshot")?.viewport
                ? {
                    viewport: hasFormatOfType(
                      meta.options.formats,
                      "screenshot",
                    )!.viewport,
                  }
                : {}),
            },
          ]
        : []),
      ...(hasFormatOfType(meta.options.formats, "branding")
        ? [
            {
              type: "executeJavascript" as const,
              script: getBrandingScript(),
            },
          ]
        : []),
    ];

    const totalWait = actions.reduce(
      (a, x) => (x.type === "wait" ? (x.milliseconds ?? 1000) + a : a),
      0,
    );

    const shouldAllowMedia =
      hasFormatOfType(meta.options.formats, "branding") ||
      youtubePostprocessor.shouldRun(
        meta,
        new URL(meta.rewrittenUrl ?? meta.url),
      );

    const request: FireEngineScrapeRequestCommon &
      FireEngineScrapeRequestChromeCDP = {
      url: meta.rewrittenUrl ?? meta.url,
      engine: "chrome-cdp",
      instantReturn: false,
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
      saveScrapeResultToGCS:
        !meta.internalOptions.zeroDataRetention &&
        meta.internalOptions.saveScrapeResultToGCS,
      zeroDataRetention: meta.internalOptions.zeroDataRetention,
      ...(shouldAllowMedia ? { blockMedia: false } : {}),
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

    const javascriptReturns = (response.actionResults ?? [])
      .filter(x => x.type === "executeJavascript")
      .map(x => {
        const rawReturn = (x.result as { return: string }).return;
        try {
          const parsed = JSON.parse(rawReturn);
          if (
            parsed &&
            typeof parsed === "object" &&
            "type" in parsed &&
            typeof (parsed as any).type === "string" &&
            "value" in parsed
          ) {
            return {
              type: String((parsed as any).type),
              value: (parsed as any).value,
            };
          }

          return {
            type: "unknown",
            value: parsed,
          };
        } catch (error) {
          meta.logger.warn("Failed to parse executeJavascript return", {
            error,
          });
          return {
            type: "unknown",
            value: rawReturn,
          };
        }
      });

    return {
      url: response.url ?? meta.url,

      html: response.content,
      error: response.pageError,
      statusCode: response.pageStatusCode,

      contentType:
        (Object.entries(response.responseHeaders ?? {}).find(
          x => x[0].toLowerCase() === "content-type",
        ) ?? [])[1] ?? undefined,

      screenshot: response.screenshot,
      ...(actions.length > 0
        ? {
            actions: {
              screenshots: response.screenshots ?? [],
              scrapes: response.actionContent ?? [],
              javascriptReturns,
              pdfs: (response.actionResults ?? [])
                .filter(x => x.type === "pdf")
                .map(x => x.result.link),
            },
          }
        : {}),

      proxyUsed: response.usedMobileProxy ? "stealth" : "basic",
      youtubeTranscriptContent: response.youtubeTranscriptContent,
    };
  });
}

export async function scrapeURLWithFireEnginePlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  return withSpan("engine.fire-engine.playwright", async span => {
    setSpanAttributes(span, {
      "engine.type": "fire-engine-playwright",
      "engine.url": meta.url,
      "engine.team_id": meta.internalOptions.teamId,
    });
    const totalWait = meta.options.waitFor;

    const request: FireEngineScrapeRequestCommon &
      FireEngineScrapeRequestPlaywright = {
      url: meta.rewrittenUrl ?? meta.url,
      engine: "playwright",
      instantReturn: false,

      headers: meta.options.headers,
      priority: meta.internalOptions.priority,
      screenshot:
        hasFormatOfType(meta.options.formats, "screenshot") !== undefined,
      fullPageScreenshot: hasFormatOfType(meta.options.formats, "screenshot")
        ?.fullPage,
      wait: meta.options.waitFor,
      geolocation: meta.options.location,
      blockAds: meta.options.blockAds,
      mobileProxy: meta.featureFlags.has("stealthProxy"),

      timeout: meta.abort.scrapeTimeout() ?? 300000,
      saveScrapeResultToGCS:
        !meta.internalOptions.zeroDataRetention &&
        meta.internalOptions.saveScrapeResultToGCS,
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

      contentType:
        (Object.entries(response.responseHeaders ?? {}).find(
          x => x[0].toLowerCase() === "content-type",
        ) ?? [])[1] ?? undefined,

      ...(response.screenshots !== undefined && response.screenshots.length > 0
        ? {
            screenshot: response.screenshots[0],
          }
        : {}),

      proxyUsed: response.usedMobileProxy ? "stealth" : "basic",
    };
  });
}

export async function scrapeURLWithFireEngineTLSClient(
  meta: Meta,
): Promise<EngineScrapeResult> {
  return withSpan("engine.fire-engine.tlsclient", async span => {
    setSpanAttributes(span, {
      "engine.type": "fire-engine-tlsclient",
      "engine.url": meta.url,
      "engine.team_id": meta.internalOptions.teamId,
    });
    const request: FireEngineScrapeRequestCommon &
      FireEngineScrapeRequestTLSClient = {
      url: meta.rewrittenUrl ?? meta.url,
      engine: "tlsclient",
      instantReturn: false,

      headers: meta.options.headers,
      priority: meta.internalOptions.priority,

      atsv: meta.internalOptions.atsv,
      geolocation: meta.options.location,
      disableJsDom: meta.internalOptions.v0DisableJsDom,
      mobileProxy: meta.featureFlags.has("stealthProxy"),

      timeout: meta.abort.scrapeTimeout() ?? 300000,
      saveScrapeResultToGCS:
        !meta.internalOptions.zeroDataRetention &&
        meta.internalOptions.saveScrapeResultToGCS,
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

      contentType:
        (Object.entries(response.responseHeaders ?? {}).find(
          x => x[0].toLowerCase() === "content-type",
        ) ?? [])[1] ?? undefined,

      proxyUsed: response.usedMobileProxy ? "stealth" : "basic",
    };
  });
}

export function fireEngineMaxReasonableTime(
  meta: Meta,
  engine: "chrome-cdp" | "playwright" | "tlsclient",
): number {
  if (engine === "tlsclient") {
    return 15000;
  } else if (engine === "playwright") {
    return (meta.options.waitFor ?? 0) + 30000;
  } else {
    return (
      (meta.options.waitFor ?? 0) +
      (meta.options.actions?.reduce(
        (a, x) => (x.type === "wait" ? (x.milliseconds ?? 2500) + a : 250 + a),
        0,
      ) ?? 0) +
      30000
    );
  }
}
