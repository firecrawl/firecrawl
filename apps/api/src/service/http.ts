/*
 * What a route asks of the service before its handler runs.
 *
 * This file imports nothing with a startup side effect, so importing the
 * package loads no route handlers, configuration, or clients.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { v7 as uuidv7 } from "uuid";
import type { Document } from "../controllers/v2/types";
import { z } from "zod";
import { UNSUPPORTED_SITE_MESSAGE } from "../lib/strings";
import type {
  Refusal,
  RequestEvent,
  RequestKind,
  ResponseInfo,
  ResponsePayload,
} from "./hooks";
import type {
  AdmitInput,
  AuthRoute,
  AuthorizeState,
  CoreRouteKind,
  RouteKind,
} from "./modules";
import type { RequestBodies } from "./request";
import { service } from "./service";

export type { AuthRoute, CoreRouteKind, RouteKind };

/** Maps a v1/v2 route path to its `RequestKind`, if it is one of the six core kinds. */
export function requestKindForPath(path: string): RequestKind | undefined {
  switch (path.replace(/^\/v\d+/, "")) {
    case "/scrape":
      return "scrape";
    case "/parse":
      return "parse";
    case "/crawl":
      return "crawl";
    case "/batch/scrape":
      return "batchScrape";
    case "/map":
      return "map";
    case "/search":
      return "search";
    default:
      return undefined;
  }
}

/** Sends a ready-made HTTP refusal if the response has not already been sent. */
export function sendRefusal(res: Response, refusal: Refusal): void {
  if (res.headersSent) {
    return;
  }
  for (const [name, value] of Object.entries(refusal.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.status(refusal.status).json(refusal.body);
}

/** Emits `request.rejected` and sends the refusal if the response is still open. */
export function rejectRequest(
  req: Request,
  res: Response,
  kind: RequestKind,
  refusal: Refusal,
): void {
  service.hooks.observe("request.rejected", {
    kind,
    teamId: req.ctx?.teamId ?? req.caller?.teamId,
    refusal,
  });
  sendRefusal(res, refusal);
}

/**
 * Express middleware that identifies the sender of a request through the
 * active service's auth module. A request it lets through has `req.caller`;
 * a request it refuses has been answered.
 */
export function authenticate(
  kind: RouteKind,
  options?: Omit<AuthRoute, "kind">,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const route: AuthRoute = options ? { ...options, kind } : { kind };
    Promise.resolve()
      .then(() => service.modules.auth.authenticate(req, route))
      .then(result => {
        if (!result.ok) {
          const requestKind = requestKindForPath(req.path);
          if (requestKind) {
            rejectRequest(req, res, requestKind, result.refusal);
          } else {
            sendRefusal(res, result.refusal);
          }
          return;
        }
        if (!res.headersSent) {
          for (const [name, value] of Object.entries(result.headers ?? {})) {
            res.setHeader(name, value);
          }
        }
        req.caller = result.caller;
        next();
      })
      .catch(next);
  };
}

/** Options controlling how `openRequest` parses, authorizes, and checks a request. */
export interface OpenRequestOptions<K extends RequestKind = RequestKind> {
  /**
   * Minimum billable units for `billing.authorize` preflight, or a function
   * deriving them from the admitted body.
   */
  units?: number | ((body: RequestBodies[K]) => number | undefined);
  /**
   * Whether `openRequest` runs `billing.authorize` preflight. Defaults to true.
   * Set to false when an earlier middleware already ran preflight billing.
   */
  authorize?: boolean;
  /** Extra state forwarded to `billing.authorize` during preflight. */
  authorizeState?: Partial<AuthorizeState>;
  /** Optional parser overriding the default `service.schemas[kind]` parse. */
  parse?: (rawBody: unknown) => RequestBodies[K];
  /**
   * Optional handler invoked when body parsing throws. Returning `true` (or
   * writing a response) stops propagation to Express error middleware.
   */
  onParseError?: (
    error: unknown,
    req: Request,
    res: Response,
  ) => boolean | void;
  /**
   * Whether `openRequest` runs the single-URL blocklist check when the policy
   * module has not already evaluated blocklist rules. Defaults to `"single"`
   * for `scrape`, `crawl`, and `map`, and `"none"` for `parse`, `search`, and
   * `batchScrape`.
   */
  blocklist?: "none" | "single";
}

interface PreflightAuthorizeState extends Partial<AuthorizeState> {
  req: Request;
  minimum?: number;
}

function defaultBlocklistMode(kind: RequestKind): "none" | "single" {
  return kind === "scrape" || kind === "crawl" || kind === "map"
    ? "single"
    : "none";
}

type DefaultRequestParsers = {
  [K in RequestKind]: (rawBody: unknown) => RequestBodies[K];
};

const defaultRequestParsers: DefaultRequestParsers = {
  scrape: rawBody => service.schemas.scrape.parse(rawBody),
  parse: rawBody => service.schemas.parse.parse(rawBody),
  crawl: rawBody => service.schemas.crawl.parse(rawBody),
  batchScrape: rawBody =>
    z.object({ ignoreInvalidURLs: z.literal(true) }).safeParse(rawBody).success
      ? service.schemas.batchScrapeNoURLValidation.parse(rawBody)
      : service.schemas.batchScrape.parse(rawBody),
  map: rawBody => service.schemas.map.parse(rawBody),
  search: rawBody => service.schemas.search.parse(rawBody),
};

function parseBodyForKind<K extends RequestKind>(
  kind: K,
  rawBody: unknown,
  customParse?: (rawBody: unknown) => RequestBodies[K],
): RequestBodies[K] {
  if (customParse) {
    return customParse(rawBody);
  }
  return defaultRequestParsers[kind](rawBody);
}

function deriveRequestedUnits<K extends RequestKind>(
  body: RequestBodies[K],
  units: OpenRequestOptions<K>["units"],
): number | undefined {
  if (typeof units === "function") {
    return units(body);
  }
  if (typeof units === "number") {
    return units;
  }
  if (body && typeof body === "object") {
    const limitVal = "limit" in body ? body.limit : undefined;
    const urlsVal = "urls" in body ? body.urls : undefined;
    const candidate = limitVal ?? (Array.isArray(urlsVal) ? urlsVal.length : 1);
    const derived = Number(candidate);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }
  return undefined;
}

type RequestEventBuilders = {
  [K in RequestKind]: (
    id: string,
    ctx: NonNullable<Request["ctx"]>,
    body: RequestBodies[K],
  ) => RequestEvent;
};

const requestEventBuilders: RequestEventBuilders = {
  scrape: (id, ctx, body) => ({ kind: "scrape", id, ctx, body }),
  parse: (id, ctx, body) => ({ kind: "parse", id, ctx, body }),
  crawl: (id, ctx, body) => ({ kind: "crawl", id, ctx, body }),
  batchScrape: (id, ctx, body) => ({ kind: "batchScrape", id, ctx, body }),
  map: (id, ctx, body) => ({ kind: "map", id, ctx, body }),
  search: (id, ctx, body) => ({ kind: "search", id, ctx, body }),
};

function buildRequestEvent<K extends RequestKind>(
  kind: K,
  id: string,
  ctx: NonNullable<Request["ctx"]>,
  body: RequestBodies[K],
): RequestEvent {
  return requestEventBuilders[kind](id, ctx, body);
}

/**
 * Express middleware shared by core API request routes: validates the request
 * body against `service.schemas`, admits it through `service.modules.policy`,
 * checks preflight billing and URL blocklist rules, emits `request.accepted`,
 * and sets `req.ctx`, `req.body`, and `req.requestId`.
 */
export function openRequest<K extends RequestKind>(
  kind: K,
  options?: OpenRequestOptions<K>,
): RequestHandler {
  const blocklistMode = options?.blocklist ?? defaultBlocklistMode(kind);

  return (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      if (!req.caller) {
        throw new Error(
          "openRequest requires authenticate middleware to run first",
        );
      }

      const rawBody: unknown = req.body;
      req.rawRequestBody = rawBody;
      const id = req.requestId ?? uuidv7();
      req.requestId = id;

      let parsedBody: RequestBodies[K];
      try {
        parsedBody = parseBodyForKind(kind, rawBody, options?.parse);
      } catch (error) {
        if (
          options?.onParseError?.(error, req, res) === true ||
          res.headersSent
        ) {
          return;
        }
        throw error;
      }

      const admitInput: AdmitInput<K> = {
        kind,
        caller: req.caller,
        body: parsedBody,
        http: {
          ip: req.ip,
          headers: req.headers,
          path: req.path,
          method: req.method,
          rawBody,
          req,
        },
      };
      const admission = await service.modules.policy.admit(admitInput);

      if (!admission.ok) {
        rejectRequest(req, res, kind, admission.refusal);
        return;
      }

      if (!res.headersSent) {
        for (const [name, value] of Object.entries(admission.headers ?? {})) {
          res.setHeader(name, value);
        }
      }

      const admittedBody = admission.body;
      req.ctx = admission.ctx;
      req.body = admittedBody;
      if (admission.blocklistChecked) {
        req.requestBlocklistChecked = true;
      }
      if (admission.warnings && admission.warnings.length > 0) {
        req.requestWarnings = admission.warnings;
      }
      if (admission.droppedUrls && admission.droppedUrls.length > 0) {
        req.requestDroppedUrls = admission.droppedUrls;
      }

      if (options?.authorize !== false) {
        const requestedUnits = deriveRequestedUnits(
          admittedBody,
          options?.units,
        );
        const state: PreflightAuthorizeState = {
          ...(options?.authorizeState ?? {}),
          req,
        };
        if (typeof options?.units === "number") {
          state.minimum = options.units;
        }
        const authz = await service.modules.billing.authorize({
          caller: req.caller,
          operation: kind,
          stage: "preflight",
          requestedUnits,
          ctx: req.ctx,
          state,
        });

        if (!authz.ok) {
          rejectRequest(req, res, kind, authz.refusal);
          return;
        }

        req.account = {
          remainingCredits: authz.maxUnits ?? Infinity,
        };
        if (authz.clampedLimit !== undefined) {
          Object.assign(admittedBody, { limit: authz.clampedLimit });
        }
      }

      if (
        !admission.blocklistChecked &&
        blocklistMode === "single" &&
        admittedBody &&
        typeof admittedBody === "object" &&
        "url" in admittedBody &&
        typeof admittedBody.url === "string"
      ) {
        const originVal =
          "origin" in admittedBody && typeof admittedBody.origin === "string"
            ? admittedBody.origin
            : null;
        const blocked = service.modules.blocklist.isBlocked(
          admittedBody.url,
          req.ctx,
          { origin: originVal },
        );
        if (blocked) {
          rejectRequest(req, res, kind, {
            status: 403,
            body: {
              success: false,
              error: UNSUPPORTED_SITE_MESSAGE,
            },
          });
          return;
        }
      }

      await service.hooks.run(
        "request.accepted",
        buildRequestEvent(kind, id, req.ctx, admittedBody),
      );

      next();
    })().catch(next);
  };
}

/**
 * Express middleware that resolves `req.ctx` via `service.modules.policy.context`
 * for auxiliary authenticated routes outside the six `RequestKind`s.
 */
export function resolveRequestContext(route: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      if (!req.caller) {
        throw new Error(
          "resolveRequestContext requires authenticate middleware to run first",
        );
      }

      const policy = service.modules.policy;
      if (!policy.context) {
        req.ctx = {
          teamId: req.caller.teamId,
          zeroDataRetention: false,
        };
        next();
        return;
      }

      const result = await policy.context({
        route,
        caller: req.caller,
        http: {
          ip: req.ip,
          headers: req.headers,
          path: req.path,
          method: req.method,
          rawBody: req.body,
          req,
        },
      });

      if (!result.ok) {
        sendRefusal(res, result.refusal);
        return;
      }

      if (!res.headersSent) {
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          res.setHeader(name, value);
        }
      }

      req.ctx = result.ctx;
      next();
    })().catch(next);
  };
}

interface FinalizeRequest<K extends RequestKind> {
  ctx?: Request["ctx"];
  requestId?: string;
  body: RequestBodies[K];
}

/**
 * Runs `request.responding` transform hooks on a response payload before
 * sending it. Returns `payload` synchronously with zero overhead when no
 * handler is registered.
 */
export function finalizeResponse<
  K extends RequestKind,
  T extends ResponsePayload,
>(
  req: FinalizeRequest<K>,
  kind: K,
  payload: T,
  documents: Array<Document> = [],
): ResponsePayload | Promise<ResponsePayload> {
  if (!service.hooks.has("request.responding") || !req.ctx) {
    return payload;
  }
  const id = req.requestId ?? "";
  const info: ResponseInfo = {
    ...buildRequestEvent(kind, id, req.ctx, req.body),
    documents,
  };
  return service.hooks.transform("request.responding", payload, info);
}
