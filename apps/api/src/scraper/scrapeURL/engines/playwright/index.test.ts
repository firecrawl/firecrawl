import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MockedFunction } from "vitest";

import { robustFetch } from "../../lib/fetch";
import { scrapeURLWithPlaywright } from "./index";
import type { Meta } from "../..";

vi.mock("../../lib/fetch", () => ({ robustFetch: vi.fn() }));

const mockedRobustFetch = robustFetch as unknown as MockedFunction<
  typeof robustFetch
>;

const baseMeta = (overrides: Record<string, unknown> = {}): Meta =>
  ({
    id: "test",
    url: "https://example.com/start",
    rewrittenUrl: undefined,
    options: { waitFor: 0, skipTlsVerification: false },
    abort: {
      scrapeTimeout: () => 30000,
      asSignal: () => new AbortController().signal,
    },
    logger: { child: () => ({}) },
    mock: null,
    ...overrides,
  }) as unknown as Meta;

const microserviceResponse = (extra: Record<string, unknown> = {}) => ({
  content: "<html></html>",
  pageStatusCode: 200,
  ...extra,
});

describe("scrapeURLWithPlaywright final URL handling", () => {
  beforeEach(() => {
    mockedRobustFetch.mockReset();
  });

  it("uses the microservice-observed final URL after redirects", async () => {
    mockedRobustFetch.mockResolvedValue(
      microserviceResponse({
        contentType: "text/html",
        finalUrl: "https://example.com/destination",
      }) as Awaited<ReturnType<typeof robustFetch>>,
    );

    const result = await scrapeURLWithPlaywright(baseMeta());

    expect(result.url).toBe("https://example.com/destination");
  });

  it("falls back to the requested URL when the microservice does not report a final URL", async () => {
    mockedRobustFetch.mockResolvedValue(
      microserviceResponse({
        contentType: "text/html",
      }) as Awaited<ReturnType<typeof robustFetch>>,
    );

    const result = await scrapeURLWithPlaywright(baseMeta());

    expect(result.url).toBe("https://example.com/start");
  });

  it("falls back to the rewritten URL when no final URL is reported", async () => {
    mockedRobustFetch.mockResolvedValue(
      microserviceResponse({
        contentType: "text/html",
      }) as Awaited<ReturnType<typeof robustFetch>>,
    );

    const result = await scrapeURLWithPlaywright(
      baseMeta({ rewrittenUrl: "https://rewritten.example/page" }),
    );

    expect(result.url).toBe("https://rewritten.example/page");
  });

  it("ignores non-http(s) final URLs such as about:blank", async () => {
    mockedRobustFetch.mockResolvedValue(
      microserviceResponse({
        contentType: "text/html",
        finalUrl: "about:blank",
      }) as Awaited<ReturnType<typeof robustFetch>>,
    );

    const result = await scrapeURLWithPlaywright(baseMeta());

    expect(result.url).toBe("https://example.com/start");
  });

  it("ignores malformed final URLs that only look http(s), such as https:// without a host", async () => {
    mockedRobustFetch.mockResolvedValue(
      microserviceResponse({
        contentType: "text/html",
        finalUrl: "https://",
      }) as Awaited<ReturnType<typeof robustFetch>>,
    );

    const result = await scrapeURLWithPlaywright(baseMeta());

    expect(result.url).toBe("https://example.com/start");
  });

  it("ignores final URLs that cannot be parsed at all", async () => {
    mockedRobustFetch.mockResolvedValue(
      microserviceResponse({
        contentType: "text/html",
        finalUrl: "not a url",
      }) as Awaited<ReturnType<typeof robustFetch>>,
    );

    const result = await scrapeURLWithPlaywright(baseMeta());

    expect(result.url).toBe("https://example.com/start");
  });

  it("accepts an http final URL with an explicit port", async () => {
    mockedRobustFetch.mockResolvedValue(
      microserviceResponse({
        contentType: "text/html",
        finalUrl: "http://example.com:8080/destination",
      }) as Awaited<ReturnType<typeof robustFetch>>,
    );

    const result = await scrapeURLWithPlaywright(baseMeta());

    expect(result.url).toBe("http://example.com:8080/destination");
  });
});
