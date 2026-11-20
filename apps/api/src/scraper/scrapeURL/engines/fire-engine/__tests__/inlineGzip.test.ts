import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
}));

// Exercise the public engine entry points with real zlib, replacing remote
// services and unrelated content processors at their boundaries.
vi.mock("../scrape", () => ({
  fireEngineURL: "http://fire-engine.test",
  fireEngineStagingURL: "http://fire-engine-staging.test",
  fireEngineScrape: vi.fn(async () => fake.status),
  requestOverrides: () => ({}),
}));
vi.mock("../checkStatus", () => ({
  fireEngineCheckStatus: vi.fn(),
  StillProcessingError: class extends Error {},
}));
vi.mock("../delete", () => ({ fireEngineDelete: vi.fn(async () => {}) }));
vi.mock("../../utils/specialtyHandler", () => ({
  specialtyScrapeCheck: vi.fn(async () => {}),
}));
vi.mock("../../../lib/fetch", () => ({
  redactRequestBodyForLog: (body: unknown) => body,
}));
vi.mock("@mendable/firecrawl-rs", () => ({
  getInnerJson: vi.fn(async (content: string) => content),
}));
vi.mock("../../../postprocessors/youtube", () => ({
  youtubePostprocessor: { shouldRun: () => false },
}));
vi.mock("../../../../../lib/branding/jev", () => ({
  wantsBrandingScreenshot: () => undefined,
}));
vi.mock("../../../../../lib/otel-tracer", () => ({
  withSpan: (_name: string, fn: (span: unknown) => unknown) => fn({}),
  setSpanAttributes: () => {},
}));
vi.mock("../../../../../services/ab-test", () => ({
  abTestFireEngine: () => ({ mode: "off" }),
}));
vi.mock("../../../../../services/ab-test-comparison", () => ({
  scheduleABComparison: vi.fn(),
}));

import { UnsupportedFileError } from "../../../error";
import { MAX_GUNZIPPED_FILE_SIZE } from "../../utils/gunzip";
import {
  scrapeURLWithFireEngineChromeCDP,
  scrapeURLWithFireEngineTLSClient,
} from "../index";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child() {
    return this;
  },
} as any;

function meta(formats = [{ type: "markdown" }]) {
  return {
    id: "inline-gzip-scrape",
    url: "https://example.com/document",
    options: { formats, skipTlsVerification: false },
    internalOptions: { teamId: "team-a", zeroDataRetention: true },
    logger,
    abort: {
      scrapeTimeout: () => 30000,
      asSignal: () => undefined,
      throwIfAborted: () => {},
    },
    featureFlags: new Set(),
    mock: null,
  } as any;
}

function serve(bytes: Buffer) {
  fake.status.file = { content: bytes.toString("base64") };
}

beforeEach(() => {
  fake.status = {
    url: "https://example.com/document",
    content: "",
    pageStatusCode: 200,
    responseHeaders: { "content-type": "text/markdown" },
  };
});

describe.each([
  ["chrome-cdp", scrapeURLWithFireEngineChromeCDP],
  ["tlsclient", scrapeURLWithFireEngineTLSClient],
] as const)("%s inline gzip", (_name, scrapeWith) => {
  it("lets the event loop progress while inflating a large response", async () => {
    const original = "a".repeat(8 * 1024 * 1024) + "\nUnicode: 中文 🚀";
    serve(gzipSync(original));

    let settled = false;
    const otherWork = new Promise<boolean>(resolve => {
      setImmediate(() => resolve(settled));
    });
    const scrape = scrapeWith(meta()).finally(() => {
      settled = true;
    });
    const settledBeforeOtherWork = await otherWork;
    const result = await scrape;

    // There is no wall-clock threshold. A synchronous inflate settles the
    // scrape before the pending immediate can run; async zlib yields to it.
    expect(settledBeforeOtherWork).toBe(false);
    expect(result.html).toBe(original);
    expect(result.markdown).toBe(original);
    expect(result.statusCode).toBe(200);
  });

  it("keeps uncompressed UTF-8 response bytes unchanged", async () => {
    const original = "# A document\nUnicode: 中文 🚀\n";
    serve(Buffer.from(original));
    expect((await scrapeWith(meta())).html).toBe(original);
  });

  it("keeps responses without an inline file unchanged", async () => {
    fake.status.content = "# Existing content";
    expect((await scrapeWith(meta())).html).toBe("# Existing content");
  });

  it("keeps a damaged gzip response an unsupported-file error", async () => {
    serve(Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3]));
    await expect(scrapeWith(meta())).rejects.toThrow(
      new UnsupportedFileError("Failed to decompress gzip content"),
    );
  });

  it("keeps the existing 50 MiB output ceiling and error", async () => {
    serve(gzipSync(Buffer.alloc(MAX_GUNZIPPED_FILE_SIZE + 1)));
    await expect(scrapeWith(meta())).rejects.toThrow(
      new UnsupportedFileError("File exceeds size limit"),
    );
  });
});

it("returns rawBase64 gzip bytes without inflating them", async () => {
  const bytes = gzipSync("raw response");
  serve(bytes);
  const result = await scrapeURLWithFireEngineChromeCDP(
    meta([{ type: "rawBase64" }]),
  );
  expect(result.rawBase64).toBe(bytes.toString("base64"));
  expect(result.html).toBe("");
});
