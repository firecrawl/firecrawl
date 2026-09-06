import { Logger } from "winston";
import { z } from "zod";
import path from "path";
import os from "os";
import { unlink, writeFile } from "fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Meta } from "../..";
import type {
  FireEngineScrapeRequestChromeCDP,
  FireEngineScrapeRequestCommon,
} from "./scrape";
import type { FireEngineCheckStatusSuccess } from "./checkStatus";
import {
  AddFeatureError,
  PDFViewerUnresolvedError,
  type PDFViewerUnresolvedReason,
} from "../../error";
import { AbortManagerThrownError } from "../../lib/abortManager";
import type { PdfJsViewerShell } from "../../lib/pdfjsViewerShell";
import { isPdfBuffer } from "../pdf/pdfUtils";
import { isIPPrivate } from "../utils/safeFetch";
import { config } from "../../../../config";
import { hasFormatOfType } from "../../../../lib/format-utils";
import type { InternalAction } from "../../../../controllers/v1/types";

/**
 * Turns a PDF.js viewer shell (see lib/pdfjsViewerShell) into the document it
 * displays, using the browser that just rendered the shell:
 *
 *  1. When the page or its URL names the document (`viewer.html?file=…`, a
 *     literal URL in a script, an embed) and it lives on the viewer's own
 *     origin, navigate chrome-cdp to it. The download handler captures the
 *     PDF and specialtyScrapeCheck hands it to the pdf engine, exactly like
 *     a scrape of the PDF's own URL. The browser is never sent to a host the
 *     page did not already load the viewer from: a document on another
 *     origin is left to route 2, where the viewer fetches it itself.
 *  2. Otherwise — or when that URL did not yield a PDF — load the viewer
 *     again with stylesheets enabled and ask it for the bytes it fetched
 *     (`PDFViewerApplication.pdfDocument.getData()`). This covers viewers
 *     whose document comes from a script the page does not spell out and
 *     from tokenized, session-bound endpoints a second fetch could not
 *     reach: the viewer already holds the bytes.
 *
 * Stylesheets matter because our default chrome-cdp configuration blocks
 * them along with media, and pdf.js refuses to initialize when its viewer
 * container is not styled — which is also why the shell never contained
 * the document's text in the first place.
 *
 * Success is signalled the way every file handoff is: AddFeatureError with a
 * pdfPrefetch, which the scrapeURL retry loop routes to the pdf engine. When
 * nothing yields a PDF the scrape fails with PDFViewerUnresolvedError
 * instead of returning the viewer chrome as a document.
 */

export type ChromeCdpRequest = FireEngineScrapeRequestCommon &
  FireEngineScrapeRequestChromeCDP;

type PerformChromeCdpScrape = (
  request: ChromeCdpRequest,
  logger: Logger,
) => Promise<FireEngineCheckStatusSuccess>;

/**
 * Largest document the probe returns inline through the action result.
 * Bigger documents come back as a URL and take the download route, which
 * supports fire-engine's large-file handoff.
 */
const PROBE_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** How long the probe waits for the viewer to finish initializing. */
const PROBE_INIT_TIMEOUT_MS = 10_000;
/** How long the probe waits for the viewer to load its document. */
const PROBE_LOAD_TIMEOUT_MS = 20_000;

/**
 * Runs inside the viewer page. Waits for the viewer to initialize and load
 * its document, then returns the document bytes (base64) and the URL the
 * viewer loaded them from. Always resolves to a JSON string; every failure
 * is reported as `{ ok: false, reason }` rather than thrown, so fire-engine
 * never turns a viewer problem into an action error.
 */
function buildProbeScript(): string {
  return `(async () => {
  const MAX_BYTES = ${PROBE_MAX_DOCUMENT_BYTES};
  const deadline = Date.now() + ${PROBE_LOAD_TIMEOUT_MS};
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const documentUrl = app =>
    typeof app.url === "string" && app.url
      ? app.url
      : typeof app.baseUrl === "string" && app.baseUrl
        ? app.baseUrl
        : null;
  const message = error => String((error && error.message) || error);
  try {
    const app =
      typeof PDFViewerApplication !== "undefined" ? PDFViewerApplication : null;
    if (!app) return JSON.stringify({ ok: false, reason: "no_viewer_application" });
    if (app.initializedPromise) {
      const init = await Promise.race([
        app.initializedPromise.then(() => "ok", error => "failed: " + message(error)),
        sleep(${PROBE_INIT_TIMEOUT_MS}).then(() => "timeout"),
      ]);
      if (init !== "ok") {
        return JSON.stringify({ ok: false, reason: "viewer_init_failed", message: init, url: documentUrl(app) });
      }
    }
    let loadError = null;
    while (!app.pdfDocument && Date.now() < deadline) {
      const task = app.pdfLoadingTask;
      if (task && task.promise) {
        try {
          await Promise.race([task.promise, sleep(1000)]);
        } catch (error) {
          loadError = message(error);
          break;
        }
      } else {
        await sleep(250);
      }
    }
    const url = documentUrl(app);
    if (!app.pdfDocument) {
      return JSON.stringify({ ok: false, reason: loadError ? "load_failed" : "no_document", message: loadError, url });
    }
    const data = await app.pdfDocument.getData();
    if (data.length > MAX_BYTES) {
      return JSON.stringify({ ok: false, reason: "too_large", size: data.length, url });
    }
    let binary = "";
    for (let i = 0; i < data.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    }
    return JSON.stringify({ ok: true, base64: btoa(binary), size: data.length, url });
  } catch (error) {
    return JSON.stringify({ ok: false, reason: "exception", message: message(error) });
  }
})()`;
}

const probeResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    base64: z.string(),
    size: z.number(),
    url: z.string().nullable().optional(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string(),
    message: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    size: z.number().optional(),
  }),
]);

type ProbeResult = z.infer<typeof probeResultSchema>;

/**
 * fire-engine returns an executeJavascript result as the JSON of the CDP
 * remote object (`{ type: "string", value }`); the probe's own JSON is the
 * value. Null when the response carries no usable probe result.
 */
function parseProbeResult(
  response: FireEngineCheckStatusSuccess,
): ProbeResult | null {
  const action = (response.actionResults ?? []).find(
    x => x.type === "executeJavascript",
  );
  if (action === undefined || action.type !== "executeJavascript") return null;
  try {
    const remoteObject = JSON.parse(action.result.return) as unknown;
    const value =
      remoteObject !== null &&
      typeof remoteObject === "object" &&
      "value" in remoteObject
        ? (remoteObject as { value: unknown }).value
        : remoteObject;
    const parsed = probeResultSchema.safeParse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Absolute http(s) form of a URL the viewer reported, or null. */
function httpUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** pdf.js phrases its fetch failures as "Unexpected server response (404) …". */
function statusCodeFromMessage(
  message: string | null | undefined,
): number | undefined {
  const match = message?.match(/\((\d{3})\)/);
  return match ? Number(match[1]) : undefined;
}

/** Hostname suffixes that name internal infrastructure, never a public document. */
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".arpa"];

/**
 * Why a document URL taken from page content must not be fetched, or null
 * when it may be. The page chose this URL, so it is held to the standard of
 * a redirect target: a public http(s) host. Literal private, loopback and
 * link-local addresses and internal-looking names are refused outright; a
 * public-looking name is resolved and refused when any address it resolves
 * to is non-public, since the browser would follow it there. Rebinding
 * between this lookup and the navigation is out of the API's reach, as it
 * is for every redirect a scraped page performs.
 *
 * Local deployments may point viewers at internal document servers on
 * purpose; ALLOW_LOCAL_WEBHOOKS lifts the host checks here exactly as it
 * does for the API's own secure fetch.
 */
async function documentUrlRefusal(documentUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(documentUrl);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `scheme ${url.protocol} is not http(s)`;
  }
  if (config.ALLOW_LOCAL_WEBHOOKS === true) return null;
  // Brackets around an IPv6 literal and a trailing DNS root dot are both
  // spelling variants of the same host; judge the canonical form.
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (
    host === "localhost" ||
    INTERNAL_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))
  ) {
    return `host ${host} is internal`;
  }
  if (isIPPrivate(host)) {
    return `host ${host} is not a public address`;
  }
  if (!host.includes(".") && !host.includes(":")) {
    return `host ${host} is not a public hostname`;
  }
  if (isIP(host) === 0) {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return `host ${host} could not be resolved`;
    }
    const nonPublic = addresses.find(a => isIPPrivate(a.address));
    if (nonPublic !== undefined) {
      return `host ${host} resolves to a non-public address (${nonPublic.address})`;
    }
  }
  return null;
}

/** Whether two URLs share an origin; unparseable input never does. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Errors that carry the scrape's control flow through this resolver and
 * must never be swallowed: the file handoff itself (and fire-engine's own
 * stealth escalation) is an AddFeatureError; an abort is the scrape ending.
 */
function isControlFlowError(error: unknown): boolean {
  return (
    error instanceof AddFeatureError || error instanceof AbortManagerThrownError
  );
}

/**
 * The pdf handoff specialtyScrapeCheck throws when fire-engine reported a
 * PDF response but delivered no file: a "pdf" flag with a null prefetch and
 * no other file in hand. Distinct from a real handoff (a prefetch to parse)
 * and from fire-engine's own stealth escalation (no "pdf" flag).
 */
function isEmptyPdfHandoff(error: unknown): boolean {
  return (
    error instanceof AddFeatureError &&
    error.featureFlags.includes("pdf") &&
    error.pdfPrefetch == null &&
    error.documentPrefetch == null &&
    error.imagePrefetch == null
  );
}

type Failure = {
  reason: PDFViewerUnresolvedReason;
  documentUrl?: string;
  statusCode?: number;
  detail?: string;
};

function describeProbeFailure(
  probe: Extract<ProbeResult, { ok: false }>,
  viewerUrl: string,
): Failure {
  const documentUrl = httpUrl(probe.url, viewerUrl) ?? undefined;
  switch (probe.reason) {
    case "no_viewer_application":
      return {
        reason: "document_not_located",
        detail: "the page does not expose PDFViewerApplication",
      };
    case "viewer_init_failed":
      return {
        reason: "viewer_load_failed",
        documentUrl,
        detail: `the viewer did not initialize: ${probe.message ?? "unknown"}`,
      };
    case "load_failed":
      return {
        reason: "viewer_load_failed",
        documentUrl,
        statusCode: statusCodeFromMessage(probe.message),
        detail: probe.message ?? undefined,
      };
    case "no_document":
      return {
        reason: "document_not_located",
        documentUrl,
        detail: "the viewer did not load a document",
      };
    case "too_large":
      return {
        reason: "viewer_load_failed",
        documentUrl,
        detail: `the document (${probe.size ?? "?"} bytes) is too large to extract from the viewer and its URL is not fetchable`,
      };
    default:
      return {
        reason: "viewer_unavailable",
        documentUrl,
        detail: probe.message ?? probe.reason,
      };
  }
}

export async function resolvePdfJsViewerShell(
  meta: Meta,
  logger: Logger,
  request: ChromeCdpRequest,
  shellResponse: FireEngineCheckStatusSuccess,
  shell: PdfJsViewerShell,
  performScrape: PerformChromeCdpScrape,
): Promise<never> {
  const viewerUrl = shellResponse.url ?? request.url;
  const failures: Failure[] = [];
  // Each follow-up navigation gets what is left of the scrape's budget, not
  // the budget the shell navigation started with.
  const followUp = (): ChromeCdpRequest => ({
    ...request,
    timeout: meta.abort.scrapeTimeout() ?? request.timeout,
  });
  // The shell navigation honored a screenshot format, if the request had
  // one (the format's screenshot is the last one taken, as the engine
  // reads it). Carry it into the handoff so the pdf engine can return it:
  // it is the screenshot of the URL the caller asked for.
  const shellScreenshot =
    hasFormatOfType(meta.options.formats, "screenshot") !== undefined
      ? shellResponse.screenshots?.slice(-1)[0]
      : undefined;
  const withShellScreenshot = (error: unknown): unknown => {
    if (
      error instanceof AddFeatureError &&
      error.pdfPrefetch &&
      shellScreenshot !== undefined
    ) {
      error.pdfPrefetch.screenshot = shellScreenshot;
    }
    return error;
  };

  // Navigates the browser to the document. A PDF never returns from here:
  // fire-engine's download handler captures it and specialtyScrapeCheck
  // throws the AddFeatureError handoff, which propagates. Returning means
  // the URL served something else (an error page, a login wall).
  const fetchDocument = async (
    documentUrl: string,
    how: string,
  ): Promise<void> => {
    // The browser only navigates within the origin it already loaded the
    // viewer from. A document elsewhere is not fetched by us at all: the
    // viewer fetches it and the probe extracts the bytes, so the page can
    // never direct the browser (or a DNS lookup) at a host of its choosing.
    if (!sameOrigin(documentUrl, viewerUrl)) {
      logger.info("Leaving a cross-origin document to the viewer itself", {
        viewerUrl,
        documentUrl,
        how,
      });
      failures.push({
        reason: "document_fetch_failed",
        documentUrl,
        detail: "refused: the document is on another origin than the viewer",
      });
      return;
    }
    const refusal = await documentUrlRefusal(documentUrl);
    if (refusal !== null) {
      logger.warn("Refusing to fetch the viewer's document", {
        viewerUrl,
        documentUrl,
        how,
        refusal,
      });
      failures.push({
        reason: "document_fetch_failed",
        documentUrl,
        detail: `refused: ${refusal}`,
      });
      return;
    }
    logger.info("Fetching the viewer's document through the browser", {
      viewerUrl,
      documentUrl,
      how,
    });
    let response: FireEngineCheckStatusSuccess;
    try {
      // Same origin as the viewer, so the caller's headers stay where the
      // caller aimed them.
      response = await performScrape(
        { ...followUp(), url: documentUrl, actions: undefined },
        logger.child({ method: "resolvePdfJsViewerShell/fetchDocument" }),
      );
    } catch (error) {
      if (isEmptyPdfHandoff(error)) {
        // fire-engine saw a PDF but captured no file (an aborted or
        // oversized download). Propagating the empty handoff would send
        // the retry loop back to the viewer URL; the probe can still pull
        // the bytes the viewer itself holds.
        failures.push({
          reason: "document_fetch_failed",
          documentUrl,
          detail: "the browser captured no file from the document URL",
        });
        return;
      }
      if (error instanceof AddFeatureError && error.pdfPrefetch) {
        // The navigation may have been redirected: the handoff's URL is
        // where the bytes actually came from, held to the same standard.
        const finalUrl = error.pdfPrefetch.url;
        const finalRefusal =
          finalUrl !== undefined && finalUrl !== documentUrl
            ? await documentUrlRefusal(finalUrl)
            : null;
        if (finalRefusal !== null) {
          await unlink(error.pdfPrefetch.filePath).catch(() => undefined);
          logger.warn("Discarding the viewer's document after a redirect", {
            viewerUrl,
            documentUrl,
            finalUrl,
            refusal: finalRefusal,
          });
          failures.push({
            reason: "document_fetch_failed",
            documentUrl,
            detail: `refused after redirect to ${finalUrl}: ${finalRefusal}`,
          });
          return;
        }
      }
      if (isControlFlowError(error)) throw withShellScreenshot(error);
      failures.push({
        reason: "document_fetch_failed",
        documentUrl,
        detail: errorMessage(error),
      });
      return;
    }
    // The browser may have been redirected before it answered. A final URL
    // on a non-public host is refused whatever came back, so an internal
    // service's status is never reported or escalated on.
    const finalUrl = response.url;
    const finalRefusal =
      finalUrl !== undefined && finalUrl !== documentUrl
        ? await documentUrlRefusal(finalUrl)
        : null;
    if (finalRefusal !== null) {
      logger.warn("Refusing the viewer's document after a redirect", {
        viewerUrl,
        documentUrl,
        finalUrl,
        refusal: finalRefusal,
      });
      failures.push({
        reason: "document_fetch_failed",
        documentUrl,
        detail: `refused after redirect to ${finalUrl}: ${finalRefusal}`,
      });
      return;
    }
    // Only an error status says why the document was unavailable; a 2xx
    // page that is not a PDF (a login wall, a listing) must not pose as a
    // status worth reporting or hide a later 403/429 from the viewer.
    failures.push(
      response.pageStatusCode >= 400
        ? {
            reason: "document_fetch_failed",
            documentUrl,
            statusCode: response.pageStatusCode,
          }
        : {
            reason: "document_fetch_failed",
            documentUrl,
            detail: `did not return a PDF (HTTP ${response.pageStatusCode})`,
          },
    );
  };

  if (shell.document !== null) {
    await fetchDocument(shell.document.url, shell.document.source);
  }

  logger.info("Loading the viewer again to extract the document it holds", {
    viewerUrl,
    afterFailures: failures,
  });
  try {
    const probeResponse = await performScrape(
      {
        ...followUp(),
        url: viewerUrl,
        // pdf.js needs its stylesheet to initialize; keep the render fleet
        // out of it, this is a DOM-only extraction.
        blockMedia: false,
        forceNonRender: true,
        actions: [
          {
            type: "executeJavascript",
            script: buildProbeScript(),
            metadata: { __firecrawl_internal: true },
          } as InternalAction,
        ],
      },
      logger.child({ method: "resolvePdfJsViewerShell/probe" }),
    );
    const probe = parseProbeResult(probeResponse);
    if (probe === null) {
      failures.push({
        reason: "viewer_unavailable",
        detail: "the viewer probe returned no result",
      });
    } else if (probe.ok) {
      const bytes = Buffer.from(probe.base64, "base64");
      const documentUrl = httpUrl(probe.url, viewerUrl);
      if (!isPdfBuffer(bytes)) {
        failures.push({
          reason: "viewer_load_failed",
          documentUrl: documentUrl ?? undefined,
          detail: "the document the viewer holds is not a PDF",
        });
      } else {
        const filePath = path.join(
          os.tmpdir(),
          `tempFile-${crypto.randomUUID()}.pdf`,
        );
        await writeFile(filePath, bytes);
        logger.info("Extracted the viewer's document", {
          viewerUrl,
          documentUrl,
          sizeBytes: bytes.length,
        });
        throw new AddFeatureError(["pdf"], {
          filePath,
          url: documentUrl ?? viewerUrl,
          status: 200,
          proxyUsed: probeResponse.usedMobileProxy ? "stealth" : "basic",
          contentType: "application/pdf",
          screenshot: shellScreenshot,
        });
      }
    } else if (probe.reason === "too_large" && httpUrl(probe.url, viewerUrl)) {
      await fetchDocument(
        httpUrl(probe.url, viewerUrl)!,
        "reported by the viewer",
      );
    } else {
      failures.push(describeProbeFailure(probe, viewerUrl));
    }
  } catch (error) {
    if (isControlFlowError(error)) throw withShellScreenshot(error);
    failures.push({
      reason: "viewer_unavailable",
      detail: errorMessage(error),
    });
  }

  // The most actionable failure wins: a status code from the document's
  // own URL says why (expired token, login), then any status the viewer
  // observed, then whatever came first.
  const primary: Failure = failures.find(
    f => f.reason === "document_fetch_failed" && f.statusCode !== undefined,
  ) ??
    failures.find(f => f.statusCode !== undefined) ??
    failures[0] ?? { reason: "document_not_located" };

  // A blocked document endpoint is the same situation a blocked PDF URL is
  // in: give the stealth proxy one round trip before giving up. An expired
  // token (401) is not — no proxy fixes that.
  if (
    (primary.statusCode === 403 || primary.statusCode === 429) &&
    meta.options.proxy === "auto" &&
    !meta.featureFlags.has("stealthProxy")
  ) {
    logger.info(
      "The viewer's document is blocked for the current proxy; retrying with the stealth proxy",
      { viewerUrl, failures },
    );
    throw new AddFeatureError(["stealthProxy"]);
  }

  logger.warn("Could not resolve the PDF.js viewer shell to its document", {
    viewerUrl,
    signals: shell.signals,
    failures,
  });
  throw new PDFViewerUnresolvedError(
    viewerUrl,
    primary.reason,
    primary.documentUrl,
    primary.statusCode,
    primary.detail,
  );
}
