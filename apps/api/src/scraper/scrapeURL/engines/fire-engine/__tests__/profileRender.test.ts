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

import { EngineError, ProfileUnsupportedError } from "../../../error";
import { fireEngineCheckStatus } from "../checkStatus";
import { profileWouldLeaveChromeCdp } from "../profile-render";
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

function fakeMeta() {
  return {
    options: { proxy: "auto", profile: { name: "login", saveChanges: true } },
    featureFlags: new Set<string>(),
    internalOptions: {},
  } as any;
}

const polledFields = {
  jobId: "job-id",
  state: "failed" as const,
  processing: false as const,
};

describe("profileWouldLeaveChromeCdp", () => {
  it("is true for a screenshot action, which fire-engine sends to the render browser", () => {
    expect(
      profileWouldLeaveChromeCdp({
        profile: true,
        actions: [{ type: "screenshot" }],
        blockMediaFalse: false,
        forceNonRender: false,
      }),
    ).toBe(true);
  });

  it("is true when blockMedia is false and render routing is not opted out", () => {
    expect(
      profileWouldLeaveChromeCdp({
        profile: true,
        actions: [{ type: "scroll" }],
        blockMediaFalse: true,
        forceNonRender: false,
      }),
    ).toBe(true);
  });

  it("stays false for scroll and wait, and when render routing is opted out", () => {
    expect(
      profileWouldLeaveChromeCdp({
        profile: true,
        actions: [{ type: "scroll" }, { type: "wait" }],
        blockMediaFalse: false,
        forceNonRender: false,
      }),
    ).toBe(false);
    expect(
      profileWouldLeaveChromeCdp({
        profile: true,
        actions: [{ type: "screenshot" }],
        blockMediaFalse: true,
        forceNonRender: true,
      }),
    ).toBe(false);
    expect(
      profileWouldLeaveChromeCdp({
        profile: false,
        actions: [{ type: "screenshot" }],
        blockMediaFalse: true,
        forceNonRender: false,
      }),
    ).toBe(false);
  });
});

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
    { error: "Profiles require chrome-cdp" },
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
    { ...polledFields, error: "Profiles require chrome-cdp" },
  ],
])("profile render rejection in a %s", (_kind, run, status) => {
  beforeEach(() => {
    fetchFake.status = status;
  });

  it("returns a client error and does not fall through to a retryable engine failure", async () => {
    await expect(run(fakeMeta())).rejects.toBeInstanceOf(
      ProfileUnsupportedError,
    );
    await expect(run(fakeMeta())).rejects.toMatchObject({
      code: "SCRAPE_PROFILE_UNSUPPORTED",
    });
  });
});

describe("other fire-engine failures", () => {
  it("stay retryable engine errors", async () => {
    fetchFake.status = { error: "worker exploded" };
    await expect(
      fireEngineScrape(
        fakeMeta(),
        fakeLogger,
        request,
        null,
        undefined,
        "http://fire-engine.test",
      ),
    ).rejects.toBeInstanceOf(EngineError);
  });
});
