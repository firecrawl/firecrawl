import {
  actionTypesOf,
  areFormatsAllowed,
  classifyEndpoint,
  formatTypesOf,
  isEndpointAllowed,
  normalizeFormatForRestriction,
  type KeyRestrictionConfig,
} from "./key-restriction";

const unrestricted: KeyRestrictionConfig = {
  allowedFormats: [],
  allowedEndpoints: [],
};

function config(
  overrides: Partial<KeyRestrictionConfig>,
): KeyRestrictionConfig {
  return { ...unrestricted, ...overrides };
}

describe("classifyEndpoint", () => {
  it("classifies core scrape-output endpoints for v1 and v2", () => {
    expect(classifyEndpoint("/v2/scrape")).toEqual({
      api: "v2",
      group: "scrape",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v1/scrape")).toEqual({
      api: "v1",
      group: "scrape",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/crawl")).toMatchObject({ group: "crawl" });
    expect(classifyEndpoint("/v2/map")).toMatchObject({ group: "map" });
    expect(classifyEndpoint("/v2/search")).toMatchObject({ group: "search" });
    expect(classifyEndpoint("/v2/extract")).toMatchObject({
      group: "extract",
    });
    expect(classifyEndpoint("/v2/agent")).toMatchObject({ group: "agent" });
    expect(classifyEndpoint("/v2/parse")).toMatchObject({ group: "parse" });
  });

  it("groups job status/cancel endpoints with their job type", () => {
    expect(classifyEndpoint("/v2/scrape/abc-123")).toMatchObject({
      group: "scrape",
    });
    expect(classifyEndpoint("/v2/crawl/abc-123")).toMatchObject({
      group: "crawl",
    });
    expect(classifyEndpoint("/v2/crawl/abc-123/errors")).toMatchObject({
      group: "crawl",
    });
    expect(classifyEndpoint("/v2/crawl/ongoing")).toMatchObject({
      group: "crawl",
    });
    expect(classifyEndpoint("/v2/batch/scrape")).toMatchObject({
      group: "batch-scrape",
    });
    expect(classifyEndpoint("/v2/batch/scrape/abc-123")).toMatchObject({
      group: "batch-scrape",
    });
  });

  it("groups interactive-browser surfaces under browser", () => {
    expect(classifyEndpoint("/v2/scrape/abc-123/interact")).toMatchObject({
      group: "browser",
    });
    expect(classifyEndpoint("/v2/browser")).toMatchObject({
      group: "browser",
    });
    expect(classifyEndpoint("/v2/interact/abc-123")).toMatchObject({
      group: "browser",
    });
  });

  it("distinguishes research from search despite the nested path", () => {
    expect(classifyEndpoint("/v2/search/research/papers")).toMatchObject({
      group: "research",
    });
    expect(classifyEndpoint("/v2/research/foo")).toMatchObject({
      group: "research",
    });
    expect(classifyEndpoint("/v2/search")).toMatchObject({ group: "search" });
  });

  it("marks account/metadata endpoints as always allowed", () => {
    expect(classifyEndpoint("/v2/team/credit-usage")).toMatchObject({
      alwaysAllowed: true,
    });
    expect(classifyEndpoint("/v2/concurrency-check")).toMatchObject({
      alwaysAllowed: true,
    });
    expect(classifyEndpoint("/v1/team/queue-status")).toMatchObject({
      alwaysAllowed: true,
    });
  });

  it("classifies v0 and non-API paths", () => {
    expect(classifyEndpoint("/v0/scrape")).toEqual({ api: "v0" });
    expect(classifyEndpoint("/admin/xyz/redis-health")).toBeNull();
    expect(classifyEndpoint("/is-production")).toBeNull();
  });

  it("ignores query strings and returns null group for unknown v2 paths", () => {
    expect(classifyEndpoint("/v2/scrape?foo=bar")).toMatchObject({
      group: "scrape",
    });
    expect(classifyEndpoint("/v2/some-new-endpoint")).toEqual({
      api: "v2",
      group: null,
      alwaysAllowed: false,
    });
  });

  it("does not prefix-match partial segments", () => {
    expect(classifyEndpoint("/v2/scrapefoo")).toMatchObject({ group: null });
    expect(classifyEndpoint("/v2/mapper")).toMatchObject({ group: null });
  });
});

describe("isEndpointAllowed", () => {
  it("allows everything for an unrestricted config", () => {
    expect(isEndpointAllowed("/v0/scrape", unrestricted).allowed).toBe(true);
    expect(isEndpointAllowed("/v2/agent", unrestricted).allowed).toBe(true);
  });

  it("enforces the endpoint allowlist", () => {
    const c = config({ allowedEndpoints: ["scrape", "crawl"] });
    expect(isEndpointAllowed("/v2/scrape", c).allowed).toBe(true);
    expect(isEndpointAllowed("/v2/crawl/abc/errors", c).allowed).toBe(true);
    expect(isEndpointAllowed("/v2/agent", c)).toMatchObject({
      allowed: false,
      status: 403,
    });
    expect(isEndpointAllowed("/v2/search", c).allowed).toBe(false);
  });

  it("always allows account/metadata endpoints for restricted keys", () => {
    const c = config({ allowedEndpoints: ["scrape"] });
    expect(isEndpointAllowed("/v2/team/credit-usage", c).allowed).toBe(true);
    expect(isEndpointAllowed("/v2/concurrency-check", c).allowed).toBe(true);
  });

  it("denies unknown v2 endpoints when an allowlist is set", () => {
    const c = config({ allowedEndpoints: ["scrape"] });
    expect(isEndpointAllowed("/v2/some-new-endpoint", c).allowed).toBe(false);
  });

  it("denies the v0 legacy API to any restricted key", () => {
    const formatsOnly = config({ allowedFormats: ["markdown"] });
    const v0 = isEndpointAllowed("/v0/scrape", formatsOnly);
    expect(v0).toMatchObject({ allowed: false, status: 403 });
    if (!v0.allowed) {
      expect(v0.error).toContain("v0");
    }

    const endpointsOnly = config({ allowedEndpoints: ["scrape"] });
    expect(isEndpointAllowed("/v0/scrape", endpointsOnly).allowed).toBe(false);
  });

  it("does not gate endpoints when only formats are restricted", () => {
    const c = config({ allowedFormats: ["markdown"] });
    expect(isEndpointAllowed("/v2/agent", c).allowed).toBe(true);
    expect(isEndpointAllowed("/v2/scrape", c).allowed).toBe(true);
  });

  it("ignores non-API paths", () => {
    const c = config({ allowedEndpoints: ["scrape"] });
    expect(isEndpointAllowed("/admin/xyz/redis-health", c).allowed).toBe(true);
  });
});

describe("areFormatsAllowed", () => {
  it("allows everything when no format restriction is set", () => {
    expect(areFormatsAllowed(["rawHtml"], [], unrestricted).allowed).toBe(true);
    expect(
      areFormatsAllowed([], ["executeJavascript"], unrestricted).allowed,
    ).toBe(true);
  });

  it("allows requests within the format allowlist", () => {
    const c = config({ allowedFormats: ["markdown"] });
    expect(areFormatsAllowed(["markdown"], [], c).allowed).toBe(true);
    expect(areFormatsAllowed([], [], c).allowed).toBe(true);
  });

  it("rejects formats outside the allowlist", () => {
    const c = config({ allowedFormats: ["markdown"] });
    const result = areFormatsAllowed(["markdown", "rawHtml"], [], c);
    expect(result).toMatchObject({ allowed: false, status: 403 });
    if (!result.allowed) {
      expect(result.error).toContain("rawHtml");
      expect(result.error).toContain("markdown");
    }
    expect(areFormatsAllowed(["html"], [], c).allowed).toBe(false);
    expect(areFormatsAllowed(["screenshot"], [], c).allowed).toBe(false);
    expect(areFormatsAllowed(["changeTracking"], [], c).allowed).toBe(false);
  });

  it("normalizes v1 format aliases before checking", () => {
    const md = config({ allowedFormats: ["markdown"] });
    expect(areFormatsAllowed(["screenshot@fullPage"], [], md).allowed).toBe(
      false,
    );
    expect(areFormatsAllowed(["extract"], [], md).allowed).toBe(false);

    const withJson = config({ allowedFormats: ["markdown", "json"] });
    expect(areFormatsAllowed(["extract"], [], withJson).allowed).toBe(true);

    const withScreenshot = config({
      allowedFormats: ["markdown", "screenshot"],
    });
    expect(
      areFormatsAllowed(["screenshot@fullPage"], [], withScreenshot).allowed,
    ).toBe(true);
  });

  it("rejects content-returning actions on format-restricted keys", () => {
    const c = config({ allowedFormats: ["markdown"] });
    for (const action of ["scrape", "executeJavascript", "pdf"]) {
      const result = areFormatsAllowed(["markdown"], [action], c);
      expect(result).toMatchObject({ allowed: false, status: 403 });
      if (!result.allowed) {
        expect(result.error).toContain(action);
      }
    }
  });

  it("gates the screenshot action on the screenshot format", () => {
    const md = config({ allowedFormats: ["markdown"] });
    expect(areFormatsAllowed(["markdown"], ["screenshot"], md).allowed).toBe(
      false,
    );

    const withScreenshot = config({
      allowedFormats: ["markdown", "screenshot"],
    });
    expect(
      areFormatsAllowed(["markdown"], ["screenshot"], withScreenshot).allowed,
    ).toBe(true);
  });

  it("allows interaction-only actions", () => {
    const c = config({ allowedFormats: ["markdown"] });
    expect(
      areFormatsAllowed(
        ["markdown"],
        ["wait", "click", "write", "press", "scroll"],
        c,
      ).allowed,
    ).toBe(true);
  });
});

describe("format/action extraction helpers", () => {
  it("handles both v1 string and v2 object formats", () => {
    expect(formatTypesOf(["markdown", "rawHtml"])).toEqual([
      "markdown",
      "rawHtml",
    ]);
    expect(
      formatTypesOf([{ type: "markdown" }, { type: "screenshot" }]),
    ).toEqual(["markdown", "screenshot"]);
    expect(formatTypesOf(undefined)).toEqual([]);
  });

  it("extracts action types", () => {
    expect(actionTypesOf([{ type: "wait" }, { type: "screenshot" }])).toEqual([
      "wait",
      "screenshot",
    ]);
    expect(actionTypesOf(undefined)).toEqual([]);
  });

  it("normalizes known aliases and passes through the rest", () => {
    expect(normalizeFormatForRestriction("screenshot@fullPage")).toBe(
      "screenshot",
    );
    expect(normalizeFormatForRestriction("extract")).toBe("json");
    expect(normalizeFormatForRestriction("markdown")).toBe("markdown");
  });
});
