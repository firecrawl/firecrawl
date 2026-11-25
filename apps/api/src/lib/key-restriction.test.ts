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

  it("groups developer search with research on both mounts", () => {
    expect(classifyEndpoint("/v2/search/developer/search")).toMatchObject({
      group: "research",
    });
    expect(classifyEndpoint("/v2/developer/search")).toMatchObject({
      group: "research",
    });
  });

  it("groups government search with research", () => {
    expect(classifyEndpoint("/v2/search/gov")).toMatchObject({
      group: "research",
    });
  });

  it("groups team, concurrency-check, and slack endpoints under account", () => {
    expect(classifyEndpoint("/v2/team/credit-usage")).toEqual({
      api: "v2",
      group: "account",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/team/activity")).toMatchObject({
      group: "account",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/team/threat-protection")).toMatchObject({
      group: "account",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/team/siem")).toMatchObject({
      group: "account",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v1/team/queue-status")).toMatchObject({
      group: "account",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/concurrency-check")).toMatchObject({
      group: "account",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v1/concurrency-check")).toMatchObject({
      group: "account",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/slack/status")).toMatchObject({
      group: "account",
      alwaysAllowed: false,
    });
  });

  it("gives data providers and hosted shell session files their own groups", () => {
    expect(classifyEndpoint("/v2/alexandria")).toMatchObject({
      group: "alexandria",
      alwaysAllowed: false,
    });
    expect(
      classifyEndpoint("/v2/alexandria/some-provider/some/capability?q=1"),
    ).toMatchObject({ group: "alexandria", alwaysAllowed: false });
    expect(classifyEndpoint("/v2/computer/sessions")).toMatchObject({
      group: "computer",
      alwaysAllowed: false,
    });
    expect(
      classifyEndpoint("/v2/computer/sessions/abc/workspace"),
    ).toMatchObject({ group: "computer", alwaysAllowed: false });
  });

  it("marks metadata/support endpoints as always allowed", () => {
    expect(classifyEndpoint("/v2/feedback")).toMatchObject({
      alwaysAllowed: true,
    });
    expect(classifyEndpoint("/v2/support/ask")).toMatchObject({
      alwaysAllowed: true,
    });
    expect(classifyEndpoint("/v2/keyless/eligibility")).toMatchObject({
      alwaysAllowed: true,
    });
  });

  it("gives saved browser profiles their own group", () => {
    expect(classifyEndpoint("/v2/browser/profiles/work")).toMatchObject({
      group: "profiles",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/interact/profiles/work")).toMatchObject({
      group: "profiles",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/v2/browser/abc/execute")).toMatchObject({
      group: "browser",
    });
  });

  it("classifies the routers mounted beside the versioned API", () => {
    expect(classifyEndpoint("/exchange/discover/some/path?q=1")).toEqual({
      api: "exchange",
      group: "alexandria",
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/exchange/retrieve")).toMatchObject({
      group: "alexandria",
    });
    expect(classifyEndpoint("/exchange/connectors/abc")).toEqual({
      api: "exchange",
      group: null,
      alwaysAllowed: false,
    });
    expect(classifyEndpoint("/labs/search/configs")).toEqual({
      api: "labs",
      group: null,
      alwaysAllowed: false,
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

  it("gates developer search on the research group, not the web-search group", () => {
    const research = config({ allowedEndpoints: ["research"] });
    expect(
      isEndpointAllowed("/v2/search/developer/search", research).allowed,
    ).toBe(true);
    expect(isEndpointAllowed("/v2/developer/search", research).allowed).toBe(
      true,
    );

    const webSearch = config({ allowedEndpoints: ["search"] });
    expect(
      isEndpointAllowed("/v2/search/developer/search", webSearch).allowed,
    ).toBe(false);
  });

  it("gates account endpoints on the account group", () => {
    const withoutAccount = config({ allowedEndpoints: ["scrape"] });
    for (const path of [
      "/v2/team/activity",
      "/v2/team/credit-usage",
      "/v2/team/threat-protection",
      "/v2/team/siem",
      "/v2/concurrency-check",
      "/v2/slack/status",
      "/v1/team/queue-status",
    ]) {
      expect(isEndpointAllowed(path, withoutAccount)).toMatchObject({
        allowed: false,
        status: 403,
      });
    }

    const withAccount = config({ allowedEndpoints: ["scrape", "account"] });
    for (const path of [
      "/v2/team/activity",
      "/v2/team/credit-usage",
      "/v2/team/threat-protection",
      "/v2/team/siem",
      "/v2/concurrency-check",
      "/v2/slack/status",
      "/v1/team/queue-status",
    ]) {
      expect(isEndpointAllowed(path, withAccount).allowed).toBe(true);
    }
  });

  it("always allows metadata/support endpoints for restricted keys", () => {
    const c = config({ allowedEndpoints: ["scrape"] });
    expect(isEndpointAllowed("/v2/feedback", c).allowed).toBe(true);
    expect(isEndpointAllowed("/v2/support/ask", c).allowed).toBe(true);
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

  it("denies the routers beside the versioned API unless their group is allowed", () => {
    const scrapeOnly = config({ allowedEndpoints: ["scrape"] });
    for (const path of [
      "/exchange/retrieve",
      "/exchange/discover",
      "/exchange/connectors/abc",
      "/labs/search",
    ]) {
      expect(isEndpointAllowed(path, scrapeOnly)).toMatchObject({
        allowed: false,
        status: 403,
      });
    }

    const withProviders = config({ allowedEndpoints: ["alexandria"] });
    expect(isEndpointAllowed("/exchange/retrieve", withProviders).allowed).toBe(
      true,
    );
    expect(
      isEndpointAllowed("/exchange/connectors/abc", withProviders).allowed,
    ).toBe(false);

    const formatsOnly = config({ allowedFormats: ["markdown"] });
    expect(isEndpointAllowed("/labs/search", formatsOnly).allowed).toBe(true);
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
