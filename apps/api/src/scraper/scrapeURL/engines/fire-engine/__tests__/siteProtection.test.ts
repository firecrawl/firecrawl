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

import {
  AddFeatureError,
  EngineError,
  SiteBlockNoRetryError,
  SiteRestrictionError,
} from "../../../error";
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

const polledFields = {
  jobId: "job-id",
  state: "failed",
  processing: false,
};

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
    { ...siteProtectionFailure, ...polledFields },
  ],
])("site protection in a %s", (kind, run, status) => {
  const extra = kind === "polled response" ? polledFields : {};
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

  it("ends the scrape on an instant block marked not worth retrying", async () => {
    fetchFake.status = {
      error: "instant-block:example.signin-wall",
      failureReason: "site_protection",
      ...extra,
    };
    await expect(run(fakeMeta())).rejects.toBeInstanceOf(SiteBlockNoRetryError);
  });

  it("still retries an instant block that asks for stealth", async () => {
    fetchFake.status = {
      error: "instant-block:example.challenge",
      failureReason: "site_protection",
      retryWithStealth: true,
      ...extra,
    };
    await expect(run(fakeMeta())).rejects.toBeInstanceOf(AddFeatureError);
  });

  it("leaves other site protection failures without a stealth retry to the waterfall", async () => {
    fetchFake.status = {
      error: "Challenge solver at capacity",
      failureReason: "site_protection",
      ...extra,
    };
    await expect(run(fakeMeta())).rejects.toBeInstanceOf(EngineError);
  });

  it("keeps Safe Mode's restriction error ahead of the no-retry block", async () => {
    fetchFake.status = {
      error: "instant-block:example.signin-wall",
      failureReason: "site_protection",
      ...extra,
    };
    await expect(run(fakeMeta(true))).rejects.toBeInstanceOf(
      SiteRestrictionError,
    );
  });
});
