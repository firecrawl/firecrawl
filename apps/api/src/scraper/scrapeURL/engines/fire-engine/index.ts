import { Logger } from "winston";
import { Meta } from "../..";
import {
  fireEngineScrape,
  fireEngineURL,
  fireEngineStagingURL,
  FireEngineScrapeRequestChromeCDP,
  FireEngineScrapeRequestCommon,
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
  AddFeatureError,
  EngineError,
  DNSResolutionError,
  SiteError,
  SSLError,
  UnsupportedFileError,
  FEPageLoadFailed,
  ProxySelectionError,
} from "../../error";
import * as Sentry from "@sentry/node";
import { gunzipSync } from "node:zlib";
import { specialtyScrapeCheck } from "../utils/specialtyHandler";
import { fireEngineDelete } from "./delete";
import { MockState } from "../../lib/mock";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { InternalAction } from "../../../../controllers/v1/types";
import { AbortManagerThrownError } from "../../lib/abortManager";
import { youtubePostprocessor } from "../../postprocessors/youtube";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { getBrandingScript } from "./brandingScript";
import { getMenuModifierScript } from "./menuModifierScript";
import { abTestFireEngine } from "../../../../services/ab-test";
import { scheduleABComparison } from "../../../../services/ab-test-comparison";
import { createHash } from "node:crypto";

/** Default wait (ms) before running the branding script when user did not set waitFor. Lets the page settle so DOM/images are ready and reduces JS errors. */
const BRANDING_DEFAULT_WAIT_MS = 2000;

const MAX_GUNZIPPED_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// This function does not take `Meta` on purpose. It may not access any
// meta values to construct the request -- that must be done by the
// `scrapeURLWithFireEngine*` functions.
async function performFireEngineScrape<
  Engine extends
    | FireEngineScrapeRequestChromeCDP
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

    let baseUrl = production ? fireEngineURL : fireEngineStagingURL;

    const abTest = abTestFireEngine(request);
    if (abTest.mode === "split") {
      baseUrl = abTest.baseUrl;
    }

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
      "fire-engine.ab_mode": abTest.mode,
    });
    const scrape = await fireEngineScrape(
      meta,
      logger.child({ method: "fireEngineScrape" }),
      request,
      mock,
      abort,
      baseUrl,
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
            baseUrl,
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
            baseUrl,
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
            error instanceof ProxySelectionError ||
            error instanceof AddFeatureError
          ) {
            fireEngineDelete(
              logger.child({
                method: "performFireEngineScrape/fireEngineDelete",
                afterError: error,
              }),
              (scrape as any).jobId,
              mock,
              undefined,
              baseUrl,
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
              baseUrl,
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
      let buffer = Buffer.from(content, "base64");
      // transparently decompress gzipped content
      if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        try {
          buffer = gunzipSync(buffer, {
            maxOutputLength: MAX_GUNZIPPED_FILE_SIZE,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            throw new UnsupportedFileError("File exceeds size limit");
          }
          throw new UnsupportedFileError("Failed to decompress gzip content");
        }
      }
      status.content = buffer.toString("utf8"); // TODO: handle other encodings via Content-Type tag
    }

    fireEngineDelete(
      logger.child({
        method: "performFireEngineScrape/fireEngineDelete",
      }),
      (scrape as any).jobId,
      mock,
      undefined,
      baseUrl,
    ).catch(e => {
      logger.error("Failed to delete job from Fire Engine", { error: e });
    });

    if (abTest.mode === "mirror") {
      scheduleABComparison(
        meta.url,
        {
          content: status.content,
          pageStatusCode: status.pageStatusCode,
        },
        Date.now() - startTime,
        abTest.mirrorPromise,
        logger,
      );
    }

    setSpanAttributes(span, {
      "fire-engine.poll_count": pollCount,
      "fire-engine.duration_ms": Date.now() - startTime,
      "fire-engine.status_code": status.pageStatusCode,
      "fire-engine.content_length": status.content?.length,
      "fire-engine.has_screenshot": !!(
        status.screenshots && status.screenshots.length > 0
      ),
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
    const hasBranding = hasFormatOfType(meta.options.formats, "branding");
    const hasAudio = hasFormatOfType(meta.options.formats, "audio");
    const hasVideo = hasFormatOfType(meta.options.formats, "video");
    const shouldRunYoutubePostprocessor = youtubePostprocessor.shouldRun(
      meta,
      new URL(meta.rewrittenUrl ?? meta.url),
    );
    const defaultWait = hasBranding ? BRANDING_DEFAULT_WAIT_MS : 0;
    const effectiveWait =
      meta.options.waitFor != null && meta.options.waitFor !== 0
        ? meta.options.waitFor
        : defaultWait;

    const actions: InternalAction[] = [
      // Transform waitFor option into an action (unsupported by chrome-cdp).
      // When branding is requested and user didn't set waitFor, use a default wait so the page is ready and we avoid JS errors.
      ...(effectiveWait > 0
        ? [
            {
              type: "wait" as const,
              milliseconds: effectiveWait > 30000 ? 30000 : effectiveWait,
            },
          ]
        : []),

      // Include specified actions
      ...(meta.options.actions ?? []).map(action => {
        const { metadata: _, ...rest } = action as InternalAction;
        return rest;
      }),

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
              metadata: { __firecrawl_internal: true },
            },
          ]
        : []),
      ...(hasFormatOfType(meta.options.formats, "menu")?.modifiers
        ? [
            {
              type: "executeJavascript" as const,
              script: getMenuModifierScript(),
              metadata: { __firecrawl_internal: true },
            },
          ]
        : []),
      ...(hasAudio || hasVideo || shouldRunYoutubePostprocessor
        ? ([
            {
              type: "getCookies",
              metadata: { __firecrawl_internal: true },
            },
          ] as unknown as InternalAction[])
        : []),
    ];

    const totalWait = actions.reduce(
      (a, x) => (x.type === "wait" ? (x.milliseconds ?? 1000) + a : a),
      0,
    );

    const shouldAllowMedia =
      hasFormatOfType(meta.options.formats, "branding") ||
      shouldRunYoutubePostprocessor;

    const request: FireEngineScrapeRequestCommon &
      FireEngineScrapeRequestChromeCDP = {
      url: meta.rewrittenUrl ?? meta.url,
      scrapeId: meta.id,
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
      maxAge: meta.options.maxAge,
      saveScrapeResultToGCS:
        !meta.internalOptions.zeroDataRetention &&
        meta.internalOptions.saveScrapeResultToGCS,
      zeroDataRetention: meta.internalOptions.zeroDataRetention,
      ...(shouldAllowMedia ? { blockMedia: false } : {}),
      persistentStorage: meta.options.profile
        ? {
            uniqueId: `${createHash("sha256").update(meta.internalOptions.teamId).digest("hex").slice(0, 16)}_${meta.options.profile.name}`,
          }
        : undefined,
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

    let screenshot: string | undefined;
    if (hasFormatOfType(meta.options.formats, "screenshot")) {
      if (response.screenshots && response.screenshots.length > 0) {
        screenshot = response.screenshots.slice(-1)[0];
        response.screenshots = response.screenshots.slice(0, -1);
      }
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
    const audioCookies = (response.actionResults ?? [])
      .filter(x => x.type === "getCookies")
      .flatMap(x => x.result.cookies);
    const contentType =
      (Object.entries(response.responseHeaders ?? {}).find(
        x => x[0].toLowerCase() === "content-type",
      ) ?? [])[1] ?? undefined;

    return {
      url: response.url ?? meta.url,

      html: response.content,
      markdown: contentType?.includes("text/markdown")
        ? response.content
        : undefined,
      json: response.json,
      error: response.pageError,
      statusCode: response.pageStatusCode,

      contentType,

      screenshot,
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
      timezone: response.timezone,
      ...(hasAudio || hasVideo || shouldRunYoutubePostprocessor
        ? { audioCookies }
        : {}),
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
      scrapeId: meta.id,
      engine: "tlsclient",
      instantReturn: false,

      headers: meta.options.headers,
      priority: meta.internalOptions.priority,

      atsv: meta.internalOptions.atsv,
      geolocation: meta.options.location,
      disableJsDom: meta.internalOptions.v0DisableJsDom,
      mobileProxy: meta.featureFlags.has("stealthProxy"),

      timeout: meta.abort.scrapeTimeout() ?? 300000,
      maxAge: meta.options.maxAge,
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
    const contentType =
      (Object.entries(response.responseHeaders ?? {}).find(
        x => x[0].toLowerCase() === "content-type",
      ) ?? [])[1] ?? undefined;

    return {
      url: response.url ?? meta.url,

      html: response.content,
      markdown: contentType?.includes("text/markdown")
        ? response.content
        : undefined,
      json: response.json,
      error: response.pageError,
      statusCode: response.pageStatusCode,

      contentType,

      proxyUsed: response.usedMobileProxy ? "stealth" : "basic",
      timezone: response.timezone,
    };
  });
}

export function fireEngineMaxReasonableTime(
  meta: Meta,
  engine: "chrome-cdp" | "tlsclient",
): number {
  const hasBranding = hasFormatOfType(meta.options.formats, "branding");
  const defaultWait = hasBranding ? BRANDING_DEFAULT_WAIT_MS : 0;
  const effectiveWait =
    meta.options.waitFor != null && meta.options.waitFor !== 0
      ? meta.options.waitFor
      : defaultWait;

  if (engine === "tlsclient") {
    return 15000;
  } else {
    return (
      effectiveWait +
      (meta.options.actions?.reduce(
        (a, x) => (x.type === "wait" ? (x.milliseconds ?? 2500) + a : 250 + a),
        0,
      ) ?? 0) +
      30000
    );
  }
}
