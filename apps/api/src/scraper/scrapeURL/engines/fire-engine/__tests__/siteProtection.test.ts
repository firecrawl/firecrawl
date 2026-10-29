import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFake = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
}));

vi.mock("../../../lib/fetch", () => ({
  robustFetch: vi.fn(async () => fetchFake.status),
}));

vi.mock("../../../../../lib/gcs-jobs", () => ({
  getDocFromGCS: vi.fn(async () => null),
}));

import { AddFeatureError, SiteRestrictionError } from "../../../error";
import { fireEngineCheckStatus } from "../checkStatus";
import { fireEngineScrape } from "../scrape";

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child() {
    return this;
  },
} as any;

const request = {
  url: "https://example.com",
  engine: "chrome-cdp",
  timeout: 30000,
} as any;

const siteProtectionFailure = {
  error: "Site protection detected",
  failureReason: "site_protection",
  retryWithStealth: true,
};

function fakeMeta(disableSiteHandling?: boolean) {
  return {
    options: { proxy: "auto" },
    featureFlags: new Set<string>(),
    internalOptions: {
      ...(disableSiteHandling === undefined
        ? {}
        : { safeMode: { disableSiteHandling } }),
    },
  } as any;
}

describe.each([
  [
    "POST response",
    (meta: any) =>
      fireEngineScrape(
        meta,
        fakeLogger,
        request,
        null,
        undefined,
        "http://fire-engine.test",
      ),
    siteProtectionFailure,
  ],
  [
    "polled response",
    (meta: any) =>
      fireEngineCheckStatus(
        meta,
        fakeLogger,
        "job-id",
        null,
        undefined,
        "http://fire-engine.test",
      ),
    {
      ...siteProtectionFailure,
      jobId: "job-id",
      state: "failed",
      processing: false,
    },
  ],
])("site protection in a %s", (_, run, status) => {
  beforeEach(() => {
    fetchFake.status = status;
  });

  it("uses the normal retry path when Safe Mode is absent", async () => {
    await expect(run(fakeMeta())).rejects.toBeInstanceOf(AddFeatureError);
  });

  it("uses the normal retry path when Safe Mode allows site handling", async () => {
    await expect(run(fakeMeta(false))).rejects.toBeInstanceOf(AddFeatureError);
  });

  it("returns the terminal restriction error when Safe Mode disables site handling", async () => {
    await expect(run(fakeMeta(true))).rejects.toBeInstanceOf(
      SiteRestrictionError,
    );
  });
});
