import { expect, it, vi } from "vitest";

const fetchFake = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
}));
vi.mock("../../../lib/fetch", () => ({
  robustFetch: vi.fn(async () => fetchFake.status),
}));
vi.mock("../../../../../lib/gcs-jobs", () => ({
  getDocFromGCS: vi.fn(async () => null),
}));

import { EngineError } from "../../../error";
import { fireEngineCheckStatus } from "../checkStatus";
import { ScrapeProfileError } from "../profileFailure";
import { fireEngineScrape } from "../scrape";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
} as any;
const meta = {
  options: { proxy: "auto", skipTlsVerification: false },
  featureFlags: new Set<string>(),
  internalOptions: {},
} as any;
const request = { url: "https://example.com", engine: "chrome-cdp" } as any;

it("returns the profile message and leaves an untyped failure unchanged", async () => {
  const message = "Re-save the profile and try again.";
  fetchFake.status = {
    error: "failed",
    errorData: { code: "PROFILE_FAILED", message },
  };
  await expect(fireEngineScrape(meta, logger, request, null)).rejects.toEqual(
    expect.objectContaining({ name: "ScrapeProfileError", message }),
  );
  fetchFake.status = {
    ...fetchFake.status,
    jobId: "job",
    state: "failed",
    processing: false,
  };
  await expect(
    fireEngineCheckStatus(meta, logger, "job", null),
  ).rejects.toBeInstanceOf(ScrapeProfileError);
  fetchFake.status = { error: "Profile read failed (500)" };
  await expect(
    fireEngineScrape(meta, logger, request, null),
  ).rejects.toBeInstanceOf(EngineError);
});
