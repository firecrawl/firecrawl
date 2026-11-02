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
    expect(rawContentDocument(item(42))).toBeNull();
  });
});
