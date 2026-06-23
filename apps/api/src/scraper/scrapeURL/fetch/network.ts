import type { Logger } from "winston";
import { z } from "zod";
import { createHash } from "node:crypto";
import { getInnerJson } from "@mendable/firecrawl-rs";

import { config } from "../../../config";
import { httpGateway } from "../../../lib/http-gateway";
import { hasFormatOfType } from "../../../lib/format-utils";
import type { InternalAction } from "../../../controllers/v1/types";
import { withSpan, setSpanAttributes } from "../../../lib/otel-tracer";
import { getDocFromGCS } from "../../../lib/gcs-jobs";

import type { Meta } from "../context";
import type { Fetched, FetchedActions } from "../types";
import {
  ActionError,
  DNSResolutionError,
  EngineError,
  FEPageLoadFailed,
  ProxySelectionError,
  SSLError,
  SiteError,
  UnsupportedFileError,
} from "../error";
import { getBrandingScript } from "./branding-script-bundler";
import { shouldRunYoutube } from "../parse/youtube";
import { robustFetch } from "../lib/fetch";
import { hasFeature } from "../context";

const BRANDING_DEFAULT_WAIT_MS = 2000;
const POLL_INTERVAL_MS = 500;
const POLL_ERROR_LIMIT = 3;
const TERMINAL_STATUS_ERRORS = [
  EngineError,
  SiteError,
  SSLError,
  DNSResolutionError,
  ActionError,
  UnsupportedFileError,
  FEPageLoadFailed,
  ProxySelectionError,
];

const fireEngineURL = config.FIRE_ENGINE_BETA_URL ?? "<mock-fire-engine-url>";

type SelectedProxy = { proxy: string; isMobile: boolean };

const PROXY_API_TIMEOUT_MS = config.ENV === "local" ? 2500 : 500;

export async function fetchProxy(
  type: "basic" | "mobile",
  country: string | undefined,
  logger: Logger,
  abort?: AbortSignal,
): Promise<SelectedProxy | undefined> {
  const base = config.PROXY_API_URL;
  if (!base) return undefined;

  const params = new URLSearchParams({
    type,
    country: (country ?? "us").toLowerCase(),
    local: config.ENV === "local" ? "true" : "false",
  });

  const timeout = AbortSignal.timeout(PROXY_API_TIMEOUT_MS);
  const signal = abort ? AbortSignal.any([abort, timeout]) : timeout;

  try {
    const started = Date.now();
    const res = await fetch(`${base.replace(/\/$/, "")}/proxy?${params}`, {
      signal,
    });
    if (!res.ok) {
      logger.warn("proxy-api non-ok response", {
        status: res.status,
        type,
        country,
      });
      return undefined;
    }
    const data = (await res.json()) as { proxy: string; type: string };
    logger.debug("proxy-api selected", {
      type: data.type,
      elapsedMs: Date.now() - started,
    });
    return { proxy: data.proxy, isMobile: data.type === "mobile" };
  } catch (error) {
    logger.warn("proxy-api request failed", { error, type, country });
    return undefined;
  }
}

export async function fetchViaGateway(
  meta: Meta,
  proxy: SelectedProxy | undefined,
): Promise<Fetched> {
  const started = Date.now();
  const res = await httpGateway(meta.url, {
    headers: meta.options.headers,
    proxy: proxy?.proxy,
    signal: meta.abort.asSignal(),
  });
  meta.logger.debug("http-gateway forward complete", {
    status: res.status,
    elapsedMs: Date.now() - started,
  });
  return {
    via: "gateway",
    url: res.url,
    status: res.status,
    headers: res.headers,
    buffer: res.buffer,
    contentType: res.headers.find(h => h.name.toLowerCase() === "content-type")
      ?.value,
    proxyUsed: proxy?.isMobile ? "stealth" : "basic",
  };
}

export async function fetchViaPlaywright(meta: Meta): Promise<Fetched> {
  return withSpan("adapter.playwright", async span => {
    setSpanAttributes(span, {
      "adapter.type": "playwright",
      "adapter.url": meta.url,
      "adapter.team_id": meta.internalOptions.teamId,
    });
    const response = await robustFetch({
      url: config.PLAYWRIGHT_MICROSERVICE_URL!,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        url: meta.url,
        wait_after_load: meta.options.waitFor,
        timeout: meta.abort.scrapeTimeout(),
        headers: meta.options.headers,
        skip_tls_verification: meta.options.skipTlsVerification,
      },
      logger: meta.logger.child({ method: "fetchViaPlaywright/robustFetch" }),
      schema: z.object({
        content: z.string(),
        pageStatusCode: z.number(),
        pageError: z.string().optional(),
        contentType: z.string().optional(),
      }),
      mock: meta.mock,
      abort: meta.abort.asSignal(),
    });

    let buffer = Buffer.from(response.content, "base64");
    if (response.contentType?.includes("application/json")) {
      buffer = Buffer.from(await getInnerJson(buffer.toString("utf8")), "utf8");
    }

    return {
      via: "playwright",
      url: meta.url,
      status: response.pageStatusCode,
      headers: response.contentType
        ? [{ name: "content-type", value: response.contentType }]
        : [],
      buffer,
      contentType: response.contentType,
      pageError: response.pageError,
      proxyUsed: "basic",
    };
  });
}

type CdpOptions = {
  prefetch?: Fetched;
  proxy?: SelectedProxy;
};

export async function fetchViaCdp(
  meta: Meta,
  opts: CdpOptions = {},
): Promise<Fetched> {
  return withSpan("adapter.chrome-cdp", async span => {
    setSpanAttributes(span, {
      "adapter.type": "chrome-cdp",
      "adapter.url": meta.url,
      "adapter.team_id": meta.internalOptions.teamId,
      "adapter.has_prefetch": !!opts.prefetch,
      "adapter.has_proxy": !!opts.proxy,
      "adapter.proxy_mobile": !!opts.proxy?.isMobile,
    });
    const actions = buildCdpActions(meta);
    const request = buildCdpRequest(meta, actions, opts);
    const response = await performCdpScrape(meta, request);
    return unpackCdpResponse(meta, response, actions, opts.proxy);
  });
}

function buildCdpActions(meta: Meta): InternalAction[] {
  const hasBranding = hasFormatOfType(meta.options.formats, "branding");
  const defaultWait = hasBranding ? BRANDING_DEFAULT_WAIT_MS : 0;
  const effectiveWait =
    meta.options.waitFor != null && meta.options.waitFor !== 0
      ? meta.options.waitFor
      : defaultWait;
  const screenshot = hasFormatOfType(meta.options.formats, "screenshot");

  const actions: InternalAction[] = [];
  if (effectiveWait > 0) {
    actions.push({
      type: "wait",
      milliseconds: Math.min(effectiveWait, 30000),
    });
  }
  for (const action of meta.options.actions ?? []) {
    const { metadata: _, ...rest } = action as InternalAction;
    actions.push(rest);
  }
  if (screenshot) {
    actions.push({
      type: "screenshot",
      fullPage: screenshot.fullPage ?? false,
      ...(screenshot.viewport ? { viewport: screenshot.viewport } : {}),
    });
  }
  if (hasBranding) {
    actions.push({
      type: "executeJavascript",
      script: getBrandingScript(),
      metadata: { __firecrawl_internal: true },
    });
  }
  return actions;
}

type CdpRequest = {
  url: string;
  scrapeId: string;
  engine: "chrome-cdp";
  instantReturn: false;
  skipTlsVerification: boolean;
  headers?: Record<string, string>;
  actions?: InternalAction[];
  priority?: number;
  geolocation?: { country?: string; languages?: string[] };
  mobile?: boolean;
  timeout: number;
  disableSmartWaitCache?: boolean;
  customProxy?: string;
  mobileProxy?: boolean;
  saveScrapeResultToGCS?: boolean;
  zeroDataRetention?: boolean;
  blockMedia?: boolean;
  persistentStorage?: { uniqueId: string };
  prefetch?: {
    html: string;
    status: number;
    headers: Array<{ name: string; value: string }>;
  };
};

function buildCdpRequest(
  meta: Meta,
  actions: InternalAction[],
  opts: CdpOptions,
): CdpRequest {
  const allowMedia =
    hasFormatOfType(meta.options.formats, "branding") ||
    shouldRunYoutube(new URL(meta.url));
  const targetUrl = opts.prefetch?.url ?? meta.url;

  return {
    url: targetUrl,
    scrapeId: meta.id,
    engine: "chrome-cdp",
    instantReturn: false,
    skipTlsVerification: meta.options.skipTlsVerification,
    headers: meta.options.headers,
    ...(actions.length > 0 ? { actions } : {}),
    priority: meta.internalOptions.priority,
    geolocation: meta.options.location,
    mobile: meta.options.mobile,
    timeout: meta.abort.scrapeTimeout() ?? 300000,
    disableSmartWaitCache: meta.internalOptions.disableSmartWaitCache,
    ...(opts.proxy
      ? { customProxy: opts.proxy.proxy, mobileProxy: opts.proxy.isMobile }
      : { mobileProxy: hasFeature(meta, "stealthProxy") }),
    saveScrapeResultToGCS:
      !meta.internalOptions.zeroDataRetention &&
      meta.internalOptions.saveScrapeResultToGCS,
    zeroDataRetention: meta.internalOptions.zeroDataRetention,
    ...(allowMedia ? { blockMedia: false } : {}),
    persistentStorage: meta.options.profile
      ? {
          uniqueId: `${createHash("sha256")
            .update(meta.internalOptions.teamId)
            .digest("hex")
            .slice(0, 16)}_${meta.options.profile.name}`,
        }
      : undefined,
    ...(opts.prefetch
      ? {
          prefetch: {
            html: opts.prefetch.buffer.toString("utf8"),
            status: opts.prefetch.status,
            headers: opts.prefetch.headers,
          },
        }
      : {}),
  };
}

const cdpSuccessSchema = z.object({
  jobId: z.string().optional(),
  timeTaken: z.number(),
  content: z.string(),
  url: z.string().optional(),
  pageStatusCode: z.number(),
  pageError: z.string().optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  screenshots: z.string().array().optional(),
  actionContent: z
    .object({ url: z.string(), html: z.string() })
    .array()
    .optional(),
  actionResults: z
    .union([
      z.object({
        idx: z.number(),
        type: z.literal("screenshot"),
        result: z.object({ path: z.string() }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("scrape"),
        result: z.union([
          z.object({ url: z.string(), html: z.string() }),
          z.object({ url: z.string(), accessibility: z.string() }),
        ]),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("executeJavascript"),
        result: z.object({ return: z.string() }),
      }),
      z.object({
        idx: z.number(),
        type: z.literal("pdf"),
        result: z.object({ link: z.string() }),
      }),
    ])
    .array()
    .optional(),
  file: z
    .object({ name: z.string(), content: z.string() })
    .optional()
    .or(z.null()),
  docUrl: z.string().optional(),
  usedMobileProxy: z.boolean().optional(),
  youtubeTranscriptContent: z.any().optional(),
  timezone: z.string().optional(),
});

type CdpSuccess = z.infer<typeof cdpSuccessSchema>;

const cdpProcessingSchema = z.object({
  jobId: z.string(),
  processing: z.boolean(),
});

const cdpFailedSchema = z.object({ error: z.string() });

type CdpProcessing = { processing: true; jobId: string };
type CdpResult = CdpSuccess | CdpProcessing;

function isProcessing(r: CdpResult): r is CdpProcessing {
  return "processing" in r && r.processing === true;
}

async function fireEngineCall(
  meta: Meta,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<CdpResult> {
  let raw = await fetchFireEngine(meta, url, method, body, true);
  if (!raw.content && raw.docUrl) {
    const doc = await getDocFromGCS(raw.docUrl.split("/").pop() ?? "");
    if (doc) {
      raw = { ...raw, ...doc };
      delete raw.docUrl;
    }
  }

  const success = cdpSuccessSchema.safeParse(raw);
  if (success.success) {
    if (
      success.data.pageStatusCode === 415 &&
      success.data.pageError?.startsWith("Unsupported Media Type:")
    ) {
      throw new UnsupportedFileError(success.data.pageError);
    }
    return success.data;
  }

  const processing = cdpProcessingSchema.safeParse(raw);
  if (processing.success) {
    return { processing: true, jobId: processing.data.jobId };
  }

  const failed = cdpFailedSchema.safeParse(raw);
  if (failed.success) throwCdpError(meta, failed.data.error);

  throw new Error("fire-engine response did not match any schema", {
    cause: { raw },
  });
}

async function performCdpScrape(
  meta: Meta,
  request: CdpRequest,
): Promise<CdpSuccess> {
  const started = Date.now();
  const baseUrl = fireEngineURL;
  const submit = await fireEngineCall(
    meta,
    "POST",
    `${baseUrl}/scrape`,
    request,
  );
  const jobId = submit.jobId;
  try {
    const status = isProcessing(submit)
      ? await pollCdpStatus(meta, submit.jobId, baseUrl)
      : submit;

    meta.logger.debug("chrome-cdp scrape complete", {
      status: status.pageStatusCode,
      elapsedMs: Date.now() - started,
    });
    return status;
  } finally {
    if (jobId) {
      fireEngineDelete(meta.logger, jobId, baseUrl).catch(e => {
        meta.logger.error("Failed to delete job from Fire Engine", {
          error: e,
        });
      });
    }
  }
}

function throwCdpError(meta: Meta, error: string): never {
  if (error.includes("Chrome error: ")) {
    const code = error.split("Chrome error: ")[1];
    if (
      code.includes("ERR_CERT_") ||
      code.includes("ERR_SSL_") ||
      code.includes("ERR_BAD_SSL_")
    ) {
      throw new SSLError(meta.options.skipTlsVerification);
    }
    throw new SiteError(code);
  }
  if (error.includes("Dns resolution error for hostname: ")) {
    throw new DNSResolutionError(
      error.split("Dns resolution error for hostname: ")[1],
    );
  }
  if (error.includes("File size exceeds")) {
    throw new UnsupportedFileError(
      "File size exceeds " + error.split("File size exceeds ")[1],
    );
  }
  if (error.includes("failed to finish without timing out")) {
    meta.logger.warn("CDP timed out while loading the page");
    throw new FEPageLoadFailed();
  }
  if (
    error.includes("Element") ||
    error.includes("Javascript execution failed")
  ) {
    const msg = error.startsWith("Error: ") ? error.substring(7) : error;
    throw new ActionError(msg);
  }
  if (error.includes("proxies available for")) {
    throw new ProxySelectionError();
  }
  throw new EngineError("Scrape job failed", { cause: { error } });
}

async function pollCdpStatus(
  meta: Meta,
  jobId: string,
  baseUrl: string,
): Promise<CdpSuccess> {
  const errors: unknown[] = [];
  while (true) {
    meta.abort.throwIfAborted();
    try {
      const r = await fireEngineCall(meta, "GET", `${baseUrl}/scrape/${jobId}`);
      if (!isProcessing(r)) return r;
    } catch (error) {
      if (
        TERMINAL_STATUS_ERRORS.some(cls => error instanceof cls) ||
        (error as Error)?.name === "AbortManagerThrownError"
      ) {
        throw error;
      }
      errors.push(error);
      meta.logger.debug(
        `Unexpected error in checkStatus (attempt ${errors.length}/${POLL_ERROR_LIMIT})`,
        { error, jobId },
      );
      if (errors.length >= POLL_ERROR_LIMIT) {
        throw new Error("Error limit hit on fire-engine status polling", {
          cause: { errors },
        });
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function fireEngineDelete(
  logger: Logger,
  jobId: string,
  baseUrl: string,
): Promise<void> {
  try {
    await fetch(`${baseUrl}/scrape/${jobId}`, { method: "DELETE" });
  } catch (error) {
    logger.warn("fire-engine delete failed", { error, jobId });
  }
}

async function fetchFireEngine(
  meta: Meta,
  url: string,
  method: "GET" | "POST",
  body: unknown,
  allowNonOk: boolean,
): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: meta.abort.asSignal(),
      });
      if (!res.ok && !allowNonOk) {
        throw new Error(`fire-engine ${method} ${url} → ${res.status}`);
      }
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  }
  throw lastError;
}

function unpackCdpResponse(
  meta: Meta,
  response: CdpSuccess,
  actions: InternalAction[],
  proxy: SelectedProxy | undefined,
): Fetched {
  if (!response.url) {
    meta.logger.warn("Fire-engine did not return the response's URL", {
      sourceURL: meta.url,
    });
  }

  let screenshots: string[] | undefined = response.screenshots;
  let screenshotForFormat: string | undefined;
  if (hasFormatOfType(meta.options.formats, "screenshot") && screenshots) {
    screenshotForFormat = screenshots.slice(-1)[0];
    screenshots = screenshots.slice(0, -1);
  }

  const headers: Array<{ name: string; value: string }> = Object.entries(
    response.responseHeaders ?? {},
  ).map(([name, value]) => ({ name, value: String(value) }));
  const contentType = headers.find(
    h => h.name.toLowerCase() === "content-type",
  )?.value;

  const actionsPayload: FetchedActions | undefined =
    actions.length > 0
      ? {
          screenshots: screenshots ?? [],
          scrapes: response.actionContent ?? [],
          javascriptReturns: parseJsReturns(meta, response),
          pdfs: (response.actionResults ?? [])
            .filter(x => x.type === "pdf")
            .map(x => (x.result as { link: string }).link),
        }
      : undefined;

  return {
    via: "cdp",
    url: response.url ?? meta.url,
    status: response.pageStatusCode,
    headers,
    buffer: response.file
      ? Buffer.from(response.file.content, "base64")
      : Buffer.from(response.content, "utf8"),
    contentType,
    screenshots: screenshotForFormat ? [screenshotForFormat] : undefined,
    actions: actionsPayload,
    pageError: response.pageError,
    proxyUsed: proxy?.isMobile ? "stealth" : "basic",
    youtubeTranscriptContent: response.youtubeTranscriptContent,
    timezone: response.timezone,
  };
}

function parseJsReturns(
  meta: Meta,
  response: CdpSuccess,
): { type: string; value: unknown }[] {
  return (response.actionResults ?? [])
    .filter(x => x.type === "executeJavascript")
    .map(x => {
      const raw = (x.result as { return: string }).return;
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "type" in parsed &&
          typeof (parsed as { type: unknown }).type === "string" &&
          "value" in parsed
        ) {
          return {
            type: String((parsed as { type: string }).type),
            value: (parsed as { value: unknown }).value,
          };
        }
        return { type: "unknown", value: parsed };
      } catch (error) {
        meta.logger.warn("Failed to parse executeJavascript return", { error });
        return { type: "unknown", value: raw };
      }
    });
}
