import { Request, Response } from "express";
import { logger } from "./logger";
import { requestOrigin } from "./request-origin";
import { resolveIntegration } from "../utils/integration";

interface Deprecation {
  message: string;
  replacement?: string;
  // RFC 9745 requires a Date here, e.g. "@1788393600".
  deprecatedAt: string;
  // RFC 8594 IMF-fixdate.
  sunset?: string;
  docs?: string;
}

const DEPRECATIONS = {
  v2_research_github_search: {
    message:
      "The research index GitHub search (GET /v2/search/research/github, legacy GET /v2/research/github) was removed on 2026-11-03. Send the same query and k to GET or POST /v2/search/developer instead. See https://docs.firecrawl.dev/features/developer.",
    replacement: "/v2/search/developer",
    docs: "https://docs.firecrawl.dev/features/developer",
    deprecatedAt: "@1788393600",
    sunset: "Tue, 03 Nov 2026 23:59:59 GMT",
  },
} as const satisfies Record<string, Deprecation>;

type DeprecationKey = keyof typeof DEPRECATIONS;

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
