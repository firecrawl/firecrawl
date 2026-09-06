import type { NextFunction, Request, Response } from "express";

const NOT_FOUND_DOCUMENTATION_URL =
  "https://docs.firecrawl.dev/api-reference/introduction";

// Express 5 router internals. Layers expose pure matcher functions, so this
// walk never mutates routing state.
type LayerMatch = { path: string } | false;
type Matcher = (path: string) => LayerMatch;
type Layer = {
  matchers?: Matcher[];
  // Set by Express for a router mounted with no path (`app.use(router)`).
  // Express short-circuits on this flag and never consults `matchers`, whose
  // patterns only match "/" for such a layer.
  slash?: boolean;
  route?: { methods?: Record<string, boolean> };
  handle?: unknown;
};
type StackHolder = { stack?: Layer[] };

function hasStack(value: unknown): value is { stack: Layer[] } {
  if (typeof value !== "function" && typeof value !== "object") {
    return false;
  }
  return value !== null && Array.isArray((value as StackHolder).stack);
}

function walk(stack: Layer[], path: string, found: Set<string>): void {
  for (const layer of stack) {
    const matchers = layer.matchers;
    if (!Array.isArray(matchers)) {
      continue;
    }

    // A root-mounted layer matches every path and consumes no prefix, so the
    // full path is passed down. Reading the flag keeps the walk pure;
    // `layer.match()` would assign `params`/`path` on the shared layer.
    const matches: Exclude<LayerMatch, false>[] =
      layer.slash === true
        ? [{ path: "" }]
        : matchers
            .map(match => match(path))
            .filter(
              (match): match is Exclude<LayerMatch, false> => match !== false,
            );

    if (matches.length === 0) {
      continue;
    }

    if (layer.route) {
      const methods = layer.route.methods ?? {};
      for (const [method, enabled] of Object.entries(methods)) {
        if (enabled && method !== "_all") {
          found.add(method.toUpperCase());
        }
      }
      continue;
    }

    // A mounted sub-router. Strip the prefix it matched and recurse.
    if (!hasStack(layer.handle)) {
      continue;
    }
    for (const matched of matches) {
      const rest = path.slice(matched.path.length);
      walk(layer.handle.stack, rest === "" ? "/" : rest, found);
    }
  }
}

/**
 * Methods registered for `path` anywhere in the app, ignoring the method of the
 * request that missed. Returns an empty set when the path itself is unknown.
 */
function allowedMethodsForPath(app: unknown, path: string): Set<string> {
  const found = new Set<string>();
  try {
    const router = (app as { router?: StackHolder }).router;
    if (router && Array.isArray(router.stack)) {
      walk(router.stack, path, found);
    }
  } catch {
    // Router internals are not part of Express's public API. If they ever move,
    // fall back to a plain 404 rather than failing the request.
    return new Set<string>();
  }
  if (found.has("GET")) {
    found.add("HEAD");
  }
  return found;
}

/**
 * Terminal handler for requests that matched no route. Replaces Express's
 * default HTML "Cannot GET /v2/scrape" page with JSON in the same envelope the
 * rest of the API uses, and answers 405 with an Allow header when the path
 * exists under a different method.
 *
 * Must be registered after every router and before the error middleware.
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const allowed = [...allowedMethodsForPath(req.app, req.path)]
    .filter(method => method !== req.method)
    .sort();

  if (allowed.length > 0) {
    res.setHeader("Allow", allowed.join(", "));
    res.status(405).json({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      error: `${req.method} ${req.path} is not supported. Use ${allowed.join(", ")} instead.`,
      allowed_methods: allowed,
      documentation_url: NOT_FOUND_DOCUMENTATION_URL,
    });
    return;
  }

  res.status(404).json({
    success: false,
    code: "NOT_FOUND",
    error: `${req.method} ${req.path} is not a Firecrawl API endpoint.`,
    documentation_url: NOT_FOUND_DOCUMENTATION_URL,
  });
}
