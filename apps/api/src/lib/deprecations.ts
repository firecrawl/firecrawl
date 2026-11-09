import { NextFunction, Request, Response } from "express";
import { logger } from "./logger";
import { requestOrigin } from "./request-origin";
import { resolveIntegration } from "../utils/integration";
import { getApiKeyTeamFlags } from "../controllers/auth";
import type { RequestWithMaybeACUC, TeamFlags } from "../controllers/v1/types";

interface Deprecation {
  message: string;
  replacement?: string;
  // RFC 9745 requires a Date here, e.g. "@1788393600".
  deprecatedAt: string;
  // RFC 8594 IMF-fixdate. From then on deprecationMiddleware answers 410,
  // except for a team whose deprecationExtensions flag runs later.
  sunset?: string;
  docs?: string;
  // Key of the team extension flag, shared by every entry of one surface.
  // Defaults to the entry's own key.
  surface?: string;
}

export interface Notice {
  message: string;
  links?: string[];
  replacement?: string;
}

// Every legacy entry shipped together in #3469, so they share one date.
const DEPRECATIONS = {
  v1_extract: {
    message:
      "/v1/extract is deprecated. Use /v2/scrape with formats including a 'json' format object.",
    replacement: "/v2/scrape",
    deprecatedAt: "@1778025600",
  },
  v1_extract_status: {
    message:
      "/v1/extract/:jobId is deprecated. Use /v2/scrape with formats including a 'json' format object.",
    replacement: "/v2/scrape",
    deprecatedAt: "@1778025600",
  },
  v2_extract: {
    message:
      "/v2/extract is deprecated. Use /v2/scrape with formats including a 'json' format object.",
    replacement: "/v2/scrape",
    deprecatedAt: "@1778025600",
  },
  v2_extract_status: {
    message:
      "/v2/extract/:jobId is deprecated. Use /v2/scrape with formats including a 'json' format object.",
    replacement: "/v2/scrape",
    deprecatedAt: "@1778025600",
  },
  v2_research_github_search: {
    message:
      "The research index GitHub search (GET /v2/search/research/github, legacy GET /v2/research/github) was removed on 2026-11-03. Send the same query and k to GET or POST /v2/search/developer instead. See https://docs.firecrawl.dev/features/developer.",
    replacement: "/v2/search/developer",
    docs: "https://docs.firecrawl.dev/features/developer",
    deprecatedAt: "@1788393600",
    sunset: "Tue, 03 Nov 2026 23:59:59 GMT",
  },
  v1_deep_research: {
    message: "/v1/deep-research is deprecated. Use /v2/search instead.",
    replacement: "/v2/search",
    deprecatedAt: "@1778025600",
  },
  v1_deep_research_status: {
    message: "/v1/deep-research/:jobId is deprecated. Use /v2/search instead.",
    replacement: "/v2/search",
    deprecatedAt: "@1778025600",
  },
  v1_llmstxt: {
    message: "/v1/llmstxt is deprecated and will not be replaced.",
    deprecatedAt: "@1778025600",
  },
  v1_llmstxt_status: {
    message: "/v1/llmstxt/:jobId is deprecated and will not be replaced.",
    deprecatedAt: "@1778025600",
  },
  v0_scrape: {
    message: "/v0/scrape is deprecated. Use /v2/scrape instead.",
    replacement: "/v2/scrape",
    deprecatedAt: "@1778025600",
    surface: "v0",
  },
  v0_crawl: {
    message: "/v0/crawl is deprecated. Use /v2/crawl instead.",
    replacement: "/v2/crawl",
    deprecatedAt: "@1778025600",
    surface: "v0",
  },
  v0_crawl_status: {
    message:
      "/v0/crawl/status/:jobId is deprecated. Use /v2/crawl/:jobId instead.",
    replacement: "/v2/crawl/:jobId",
    deprecatedAt: "@1778025600",
    surface: "v0",
  },
  v0_crawl_cancel: {
    message:
      "/v0/crawl/cancel/:jobId is deprecated. Use DELETE /v2/crawl/:jobId instead.",
    replacement: "/v2/crawl/:jobId",
    deprecatedAt: "@1778025600",
    surface: "v0",
  },
  v0_search: {
    message: "/v0/search is deprecated. Use /v2/search instead.",
    replacement: "/v2/search",
    deprecatedAt: "@1778025600",
    surface: "v0",
  },
} as const satisfies Record<string, Deprecation>;

type DeprecationKey = keyof typeof DEPRECATIONS;

// RFC 7234 quoted-string: escape backslash and double quote.
function quoteWarningText(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Copies the body: the research controllers log the same object after responding.
export function applyNotice(res: Response, notice: Notice) {
  if (notice.links?.length) res.setHeader("Link", notice.links.join(", "));
  // RFC 7234 Warning header, code 299 = "Miscellaneous Persistent Warning".
  res.setHeader("Warning", `299 - ${quoteWarningText(notice.message)}`);

  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const existing = Array.isArray(body.warnings) ? body.warnings : [];
      const annotated: any = {
        ...body,
        warnings: [...existing, notice.message],
      };
      if (notice.replacement && annotated.replacement === undefined) {
        annotated.replacement = notice.replacement;
      }
      return originalJson(annotated);
    }
    return originalJson(body);
  };
}

function setDeprecationHeaders(res: Response, dep: Deprecation) {
  // RFC 9745 Deprecation header.
  res.setHeader("Deprecation", dep.deprecatedAt);
  // RFC 8594 Sunset header.
  if (dep.sunset) res.setHeader("Sunset", dep.sunset);

  // RFC 8288 Link relations: "deprecation" (RFC 9745) for docs, and
  // "successor-version" (RFC 5829) for the replacement endpoint.
  const links: string[] = [];
  if (dep.docs) links.push(`<${dep.docs}>; rel="deprecation"`);
  if (dep.replacement) {
    links.push(`<${dep.replacement}>; rel="successor-version"`);
  }
  if (links.length) res.setHeader("Link", links.join(", "));
}

/**
 * The instant a sunset takes effect, Infinity without one. Throws unless the
 * value is an exact IMF-fixdate, e.g. "Tue, 03 Nov 2026 23:59:59 GMT".
 */
export function sunsetInstant(key: string, sunset: string | undefined): number {
  if (sunset === undefined) return Infinity;
  const at = Date.parse(sunset);
  if (Number.isNaN(at) || new Date(at).toUTCString() !== sunset) {
    throw new Error(`Deprecation ${key} has an unreadable sunset: ${sunset}`);
  }
  return at;
}

const EXTENSION_UNTIL = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)?$/;

/**
 * Whether a team's deprecationExtensions flag keeps a sunset route working for
 * it now. Anything but an exact YYYY-MM-DD or UTC timestamp counts as none.
 */
export function hasSunsetExtension(
  key: string,
  dep: Pick<Deprecation, "surface">,
  flags: TeamFlags | null | undefined,
  now = Date.now(),
): boolean {
  const until = flags?.deprecationExtensions?.[dep.surface ?? key];
  if (typeof until !== "string" || !EXTENSION_UNTIL.test(until)) return false;
  const at = Date.parse(until);
  return (
    !Number.isNaN(at) &&
    new Date(at).toISOString().startsWith(until.replace(/Z$/, "")) &&
    now < at
  );
}

/**
 * Mount after authMiddleware where the route has one: past sunset it reads the
 * team's extension from req.acuc, so keyless callers still get 401 first.
 */
export function deprecationMiddleware(key: DeprecationKey) {
  const dep: Deprecation = DEPRECATIONS[key];
  const sunsetAt = sunsetInstant(key, dep.sunset);

  const annotate = (res: Response) => {
    setDeprecationHeaders(res, dep);
    applyNotice(res, { message: dep.message, replacement: dep.replacement });
  };

  return (req: RequestWithMaybeACUC, res: Response, next: NextFunction) => {
    if (Date.now() < sunsetAt) {
      annotate(res);
      return next();
    }

    // v0 controllers authenticate themselves, so their routes have no acuc yet.
    const lookup = req.acuc
      ? Promise.resolve(req.acuc.flags)
      : getApiKeyTeamFlags(req);
    lookup
      .then(flags => {
        if (!hasSunsetExtension(key, dep, flags)) {
          return respondRemoved(req, res, key);
        }
        annotate(res);
        next();
      })
      .catch(next);
  };
}

function respondRemoved(req: Request, res: Response, key: DeprecationKey) {
  const dep: Deprecation = DEPRECATIONS[key];
  const { origin, integration } = req.query;
  logger.warn("Removed endpoint called", {
    module: "deprecations",
    deprecation: key,
    path: req.baseUrl + req.path,
    origin: requestOrigin(
      { origin: typeof origin === "string" ? origin : undefined },
      req,
    ),
    integration:
      resolveIntegration(
        typeof integration === "string" ? integration : undefined,
        req,
      ) ?? null,
    userAgent: req.headers["user-agent"],
  });

  setDeprecationHeaders(res, dep);
  res.status(410).json({
    success: false,
    code: "ENDPOINT_REMOVED",
    error: dep.message,
    detail: dep.message,
    replacement: dep.replacement,
    documentation_url: dep.docs,
  });
}

// For an endpoint whose code is gone. Mount it ahead of auth, so every caller
// gets the pointer and nothing is rate limited, credit checked or billed.
export function removedEndpointHandler(key: DeprecationKey) {
  return (req: Request, res: Response) => respondRemoved(req, res, key);
}
