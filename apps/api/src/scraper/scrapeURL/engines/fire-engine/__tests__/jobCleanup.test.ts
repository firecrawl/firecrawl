import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  ab: { mode: "off" } as Record<string, unknown>,
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
  robustFetch: vi.fn(async () => ({})),
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
  abTestFireEngine: () => fake.ab,
}));
vi.mock("../../../../../services/ab-test-comparison", () => ({
  scheduleABComparison: vi.fn(),
}));

import { EngineError, UnsupportedFileError } from "../../../error";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import { fireEngineScrape } from "../scrape";
import { fireEngineCheckStatus, StillProcessingError } from "../checkStatus";
import { fireEngineDelete } from "../delete";
import { specialtyScrapeCheck } from "../../utils/specialtyHandler";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { robustFetch } from "../../../lib/fetch";
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
    id: "job-cleanup-scrape",
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

beforeEach(() => {
  vi.clearAllMocks();
  fake.status = {
    jobId: "retained-job",
    url: "https://example.com/document",
    content: "document",
    pageStatusCode: 200,
    responseHeaders: { "content-type": "text/markdown" },
  };
  fake.ab = { mode: "off" };
  vi.mocked(fireEngineScrape).mockImplementation(
    async () => fake.status as any,
  );
  vi.mocked(fireEngineCheckStatus).mockResolvedValue(fake.status as any);
  vi.mocked(fireEngineDelete).mockResolvedValue(undefined);
  vi.mocked(specialtyScrapeCheck).mockResolvedValue(undefined);
  vi.mocked(getInnerJson).mockImplementation(async content => content);
});

afterEach(() => vi.useRealTimers());

function expectDeletion(
  jobId = "retained-job",
  baseUrl = "http://fire-engine.test",
) {
  expect(fireEngineDelete).toHaveBeenCalledExactlyOnceWith(
    logger,
    jobId,
    null,
    undefined,
    baseUrl,
  );
}

describe.each([
  ["chrome-cdp", scrapeURLWithFireEngineChromeCDP],
  ["tlsclient", scrapeURLWithFireEngineTLSClient],
] as const)("%s job cleanup", (_name, scrapeWith) => {
  it("deletes the retained job after a successful response", async () => {
    expect((await scrapeWith(meta())).html).toBe("document");
    expectDeletion();
  });

  it("deletes the job when specialty processing rejects, preserving its error", async () => {
    const error = new UnsupportedFileError("specialty processing failed");
    vi.mocked(specialtyScrapeCheck).mockRejectedValueOnce(error);
    await expect(scrapeWith(meta())).rejects.toBe(error);
    expectDeletion();
  });

  it("deletes the job when JSON extraction rejects, preserving its error", async () => {
    fake.status.responseHeaders = { "content-type": "application/json" };
    const error = new Error("JSON extraction failed");
    vi.mocked(getInnerJson).mockRejectedValueOnce(error);
    await expect(scrapeWith(meta())).rejects.toBe(error);
    expectDeletion();
  });

  it("deletes the job after a real gzip decoding failure", async () => {
    fake.status.file = {
      content: Buffer.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3]).toString("base64"),
    };
    await expect(scrapeWith(meta())).rejects.toThrow(
      "Failed to decompress gzip content",
    );
    expectDeletion();
  });

  it("deletes the job when cancelled before the first poll", async () => {
    vi.mocked(fireEngineScrape).mockResolvedValueOnce({
      processing: true,
      jobId: "retained-job",
    } as any);
    const error = new AbortManagerThrownError("scrape", new Error("cancelled"));
    const input = meta();
    input.abort.throwIfAborted = () => {
      throw error;
    };
    await expect(scrapeWith(input)).rejects.toBe(error);
    expect(fireEngineCheckStatus).not.toHaveBeenCalled();
    expectDeletion();
  });

  it.each([
    new EngineError("poll failed"),
    new AbortManagerThrownError("engine", new Error("cancelled")),
  ])("still deletes exactly once on a terminal poll error: %s", async error => {
    vi.mocked(fireEngineScrape).mockResolvedValueOnce({
      processing: true,
      jobId: "retained-job",
    } as any);
    vi.mocked(fireEngineCheckStatus).mockRejectedValueOnce(error);
    await expect(scrapeWith(meta())).rejects.toBe(error);
    expectDeletion();
  });
});

it("deletes after a processing response finishes, including postprocessing failure", async () => {
  vi.useFakeTimers();
  vi.mocked(fireEngineScrape).mockResolvedValueOnce({
    processing: true,
    jobId: "retained-job",
  } as any);
  vi.mocked(fireEngineCheckStatus).mockRejectedValueOnce(
    new StillProcessingError(),
  );
  const error = new Error("postprocessing failed");
  vi.mocked(specialtyScrapeCheck).mockRejectedValueOnce(error);
  const result = expect(scrapeURLWithFireEngineChromeCDP(meta())).rejects.toBe(
    error,
  );
  await vi.runAllTimersAsync();
  await result;
  expect(fireEngineCheckStatus).toHaveBeenCalledTimes(2);
  expectDeletion();
});

it("still deletes exactly once when the poll retry limit is reached", async () => {
  vi.useFakeTimers();
  vi.mocked(fireEngineScrape).mockResolvedValueOnce({
    processing: true,
    jobId: "retained-job",
  } as any);
  vi.mocked(fireEngineCheckStatus).mockRejectedValue(
    new Error("transient status failure"),
  );
  const result = expect(
    scrapeURLWithFireEngineChromeCDP(meta()),
  ).rejects.toThrow("Error limit hit");
  await vi.runAllTimersAsync();
  await result;
  expect(fireEngineCheckStatus).toHaveBeenCalledTimes(3);
  expectDeletion();
});

it("uses the selected split backend and an uncancelled delete request", async () => {
  fake.ab = { mode: "split", baseUrl: "http://split-engine.test" };
  const input = meta();
  const aborted = AbortSignal.abort();
  input.abort.asSignal = () => aborted;
  const error = new Error("postprocessing failed");
  vi.mocked(specialtyScrapeCheck).mockRejectedValueOnce(error);
  await expect(scrapeURLWithFireEngineChromeCDP(input)).rejects.toBe(error);
  expectDeletion("retained-job", "http://split-engine.test");
});

it("does not replace the original error when best-effort deletion fails", async () => {
  const original = new Error("postprocessing failed");
  const deleteError = new Error("delete failed");
  vi.mocked(specialtyScrapeCheck).mockRejectedValueOnce(original);
  vi.mocked(fireEngineDelete).mockRejectedValueOnce(deleteError);
  await expect(scrapeURLWithFireEngineChromeCDP(meta())).rejects.toBe(original);
  expectDeletion();
  expect(logger.error).toHaveBeenCalledWith(
    "Failed to delete job from Fire Engine",
    { error: deleteError },
  );
});

it("does not wait for deletion or alter a successful result", async () => {
  vi.mocked(fireEngineDelete).mockReturnValueOnce(new Promise(() => {}));
  expect((await scrapeURLWithFireEngineChromeCDP(meta())).html).toBe(
    "document",
  );
  expectDeletion();
});

it("does not invent an ID for an inline response without a retained job", async () => {
  delete fake.status.jobId;
  const actual = await vi.importActual<typeof import("../delete")>("../delete");
  vi.mocked(fireEngineDelete).mockImplementationOnce(actual.fireEngineDelete);
  expect((await scrapeURLWithFireEngineChromeCDP(meta())).html).toBe(
    "document",
  );
  expect(robustFetch).not.toHaveBeenCalled();
  expect(fireEngineDelete).toHaveBeenCalledExactlyOnceWith(
    logger,
    undefined,
    null,
    undefined,
    "http://fire-engine.test",
  );
});

it("does not attempt deletion before a job is created", async () => {
  const error = new Error("submission failed");
  vi.mocked(fireEngineScrape).mockRejectedValueOnce(error);
  await expect(scrapeURLWithFireEngineChromeCDP(meta())).rejects.toBe(error);
  expect(fireEngineDelete).not.toHaveBeenCalled();
});
