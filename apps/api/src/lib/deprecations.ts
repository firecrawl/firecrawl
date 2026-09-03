import { NextFunction, Request, Response } from "express";

interface Deprecation {
  message: string;
  replacement?: string;
  // RFC 9745 requires a Date here, e.g. "@1788393600".
  deprecatedAt: string;
  sunset?: string;
  docs?: string;
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
      "The research index GitHub search (GET /v2/search/research/github, legacy GET /v2/research/github) is deprecated and stops responding after 2026-11-03. Use GET or POST /v2/search/developer instead: it searches GitHub issues, pull requests and READMEs plus curated documentation sources, returns matched passages, and adds filters for repo, language, license and stars. Response changes: 'snippet' becomes 'passages', results gain an 'id', and there is no score breakdown and no web fallback result type.",
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
  },
  v0_crawl: {
    message: "/v0/crawl is deprecated. Use /v2/crawl instead.",
    replacement: "/v2/crawl",
    deprecatedAt: "@1778025600",
  },
  v0_crawl_status: {
    message:
      "/v0/crawl/status/:jobId is deprecated. Use /v2/crawl/:jobId instead.",
    replacement: "/v2/crawl/:jobId",
    deprecatedAt: "@1778025600",
  },
  v0_crawl_cancel: {
    message:
      "/v0/crawl/cancel/:jobId is deprecated. Use DELETE /v2/crawl/:jobId instead.",
    replacement: "/v2/crawl/:jobId",
    deprecatedAt: "@1778025600",
  },
  v0_search: {
    message: "/v0/search is deprecated. Use /v2/search instead.",
    replacement: "/v2/search",
    deprecatedAt: "@1778025600",
  },
} as const satisfies Record<string, Deprecation>;

type DeprecationKey = keyof typeof DEPRECATIONS;

// RFC 7234 quoted-string: escape backslash and double quote.
function quoteWarningText(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function deprecationMiddleware(key: DeprecationKey) {
  const dep: Deprecation = DEPRECATIONS[key];
  return (req: Request, res: Response, next: NextFunction) => {
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
    if (links.length > 0) res.setHeader("Link", links.join(", "));

    // RFC 7234 Warning header, code 299 = "Miscellaneous Persistent Warning".
    res.setHeader("Warning", `299 - ${quoteWarningText(dep.message)}`);

    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        // Copy: the research controllers log the same object after responding.
        const existing = Array.isArray(body.warnings) ? body.warnings : [];
        const annotated: any = {
          ...body,
          warnings: [...existing, dep.message],
        };
        if (dep.replacement && annotated.replacement === undefined) {
          annotated.replacement = dep.replacement;
        }
        return originalJson(annotated);
      }
      return originalJson(body);
    };
    next();
  };
}
