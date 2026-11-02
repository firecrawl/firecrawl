vi.mock("uuid", () => ({
  v7: vi.fn(() => "job-1"),
}));

import {
  scrapeSearchResults,
  canServeFromRawContent,
  rawContentDocument,
} from "./scrape";
import { getJobPriority } from "../lib/job-priority";
import { processJobInternal } from "../services/worker/scrape-worker";

vi.mock("../lib/job-priority", () => ({
  getJobPriority: vi.fn().mockResolvedValue(10),
}));

vi.mock("../services/worker/scrape-worker", () => ({
  processJobInternal: vi.fn().mockResolvedValue({
    markdown: "body",
    metadata: { creditsUsed: 1, statusCode: 200, proxyUsed: "basic" },
  }),
}));

describe("scrapeSearchResults", () => {
  it("preserves billing metadata on spawned scrape jobs", async () => {
    await scrapeSearchResults(
      [
        {
          url: "https://example.com",
          title: "Example",
          description: "Desc",
        },
      ],
      {
        teamId: "team-1",
        origin: "api",
        timeout: 60_000,
        scrapeOptions: {} as any,
        apiKeyId: 123,
        requestId: "req-1",
        billing: { endpoint: "agent" },
      },
      { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
      null as any,
    );

    expect(getJobPriority).toHaveBeenCalledWith({
      team_id: "team-1",
      basePriority: 10,
    });
    expect(processJobInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          billing: { endpoint: "agent" },
        }),
      }),
    );
  });
});

describe("canServeFromRawContent", () => {
  it("accepts a plain markdown-only scrape", () => {
    expect(
      canServeFromRawContent({ formats: [{ type: "markdown" }] } as any),
    ).toBe(true);
    expect(canServeFromRawContent({ formats: ["markdown"] } as any)).toBe(true);
  });

  it("rejects any non-markdown format", () => {
    expect(
      canServeFromRawContent({
        formats: [{ type: "markdown" }, { type: "links" }],
      } as any),
    ).toBe(false);
    expect(canServeFromRawContent({ formats: [{ type: "html" }] } as any)).toBe(
      false,
    );
    expect(canServeFromRawContent({ formats: [] } as any)).toBe(false);
  });

  it("rejects requests that need the live page or the scrape pipeline", () => {
    const markdown = [{ type: "markdown" }];
    expect(
      canServeFromRawContent({
        formats: markdown,
        actions: [{ type: "wait", milliseconds: 100 }],
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, waitFor: 1000 } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        parsers: [{ type: "pdf" }],
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        headers: { "x-test": "1" },
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        includeTags: ["article"],
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        excludeTags: ["nav"],
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        profile: { name: "profile-1" },
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        redactPII: true,
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        checkPromptInjection: true,
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, mobile: true } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, lockdown: true } as any),
    ).toBe(false);
  });

  it("rejects requests that constrain the content, its freshness or its locale", () => {
    const markdown = [{ type: "markdown" }];
    // The backend fetched from its own egress: a requested location
    // (country or languages) cannot be honored.
    expect(
      canServeFromRawContent({
        formats: markdown,
        location: { country: "de" },
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        location: { languages: ["fr"] },
      } as any),
    ).toBe(false);
    // The schema's implicit default country carries no localization intent.
    expect(
      canServeFromRawContent({
        formats: markdown,
        location: { country: "us-generic" },
      } as any),
    ).toBe(true);
    // Freshness bounds are checked against Firecrawl-side fetch times by
    // the cache/index engines; the backend text's age is unverifiable.
    expect(
      canServeFromRawContent({ formats: markdown, maxAge: 0 } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, minAge: 60_000 } as any),
    ).toBe(false);
    // The onlyCleanContent LLM pass and fast mode's engine selection
    // change what the pipeline would produce.
    expect(
      canServeFromRawContent({
        formats: markdown,
        onlyCleanContent: true,
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, fastMode: true } as any),
    ).toBe(false);
    // Stealth/enhanced proxies are a different egress class; basic/auto
    // are not.
    expect(
      canServeFromRawContent({ formats: markdown, proxy: "stealth" } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, proxy: "enhanced" } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, proxy: "basic" } as any),
    ).toBe(true);
    expect(
      canServeFromRawContent({ formats: markdown, proxy: "auto" } as any),
    ).toBe(true);
    // A mock response is by definition not the backend's fetched text.
    expect(
      canServeFromRawContent({ formats: markdown, useMock: "mock-1" } as any),
    ).toBe(false);
    // Explicitly keeping page furniture an extraction strips (ads,
    // base64 images) cannot be honored; the defaults can.
    expect(
      canServeFromRawContent({ formats: markdown, blockAds: false } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({ formats: markdown, blockAds: true } as any),
    ).toBe(true);
    expect(
      canServeFromRawContent({
        formats: markdown,
        removeBase64Images: false,
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: markdown,
        removeBase64Images: true,
      } as any),
    ).toBe(true);
  });

  it("rejects an explicit full-page request (onlyMainContent: false)", () => {
    // The backend text is main-content extraction, so it cannot stand in
    // for a request that asked for the whole page.
    expect(
      canServeFromRawContent({
        formats: [{ type: "markdown" }],
        onlyMainContent: false,
      } as any),
    ).toBe(false);
    expect(
      canServeFromRawContent({
        formats: [{ type: "markdown" }],
        onlyMainContent: true,
      } as any),
    ).toBe(true);
  });
});

describe("rawContentDocument", () => {
  const item = (rawContent?: unknown) =>
    ({
      item: {
        url: "https://example.com",
        title: "Example",
        description: "Desc",
        ...(rawContent !== undefined ? { rawContent } : {}),
      },
      type: "web",
      scrapeInput: {
        url: "https://example.com",
        title: "Example",
        description: "Desc",
      },
    }) as any;

  it("builds a markdown document from the backend page text", () => {
    const result = rawContentDocument(item("page text"));
    expect(result?.document.markdown).toBe("page text");
    expect(result?.document.url).toBe("https://example.com");
    expect(result?.document.title).toBe("Example");
    expect(result?.document.metadata?.statusCode).toBe(200);
    // No scrape ran, so no scrape credits are tracked.
    expect((result?.document.metadata as any)?.creditsUsed).toBeUndefined();
  });

  it("returns null when the result carries no usable raw content", () => {
    expect(rawContentDocument(item())).toBeNull();
    expect(rawContentDocument(item(""))).toBeNull();
    // Whitespace-only text would serve as blank markdown.
    expect(rawContentDocument(item("  \n\t "))).toBeNull();
    expect(rawContentDocument(item(42))).toBeNull();
  });
});
