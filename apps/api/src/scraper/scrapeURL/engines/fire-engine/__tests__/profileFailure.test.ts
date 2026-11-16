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

import { EngineError, ScrapeProfileError } from "../../../error";
import {
  deserializeTransportableError,
  serializeTransportableError,
} from "../../../../../lib/error-serde";
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

function fakeMeta() {
  return {
    options: { proxy: "auto", skipTlsVerification: false },
    featureFlags: new Set<string>(),
    internalOptions: {},
  } as any;
}

function profileFailure(details: Record<string, unknown>, message: string) {
  return {
    error: `Failed to scrape the content, err: Error: ${message}`,
    errorData: {
      code: "PROFILE_FAILED",
      message: `Failed to scrape the content, err: Error: ${message}`,
      details,
    },
  };
}

const polledFields = {
  jobId: "job-id",
  state: "failed",
  processing: false,
};

describe.each([
  [
    "POST response",
    () =>
      fireEngineScrape(
        fakeMeta(),
        fakeLogger,
        request,
        null,
        undefined,
        "http://fire-engine.test",
      ),
    {},
  ],
  [
    "polled response",
    () =>
      fireEngineCheckStatus(
        fakeMeta(),
        fakeLogger,
        "job-id",
        null,
        undefined,
        "http://fire-engine.test",
      ),
    polledFields,
  ],
])("saved profile failures in a %s", (_kind, run, extra) => {
  beforeEach(() => {
    fetchFake.status = {};
  });

  it("turns PROFILE_FAILED into a scrape profile error", async () => {
    const message =
      "Profile load failed because the saved profile snapshot is invalid. The profile may need to be re-saved.";
    fetchFake.status = {
      ...profileFailure({ step: "load", reason: "INVALID_SNAPSHOT" }, message),
      ...extra,
    };

    await expect(run()).rejects.toMatchObject({
      step: "load",
      reason: "INVALID_SNAPSHOT",
      message,
    });
    await expect(run()).rejects.toBeInstanceOf(ScrapeProfileError);
  });

  it("keeps an untyped profile failure on the engine-error path", async () => {
    fetchFake.status = {
      error: "Profile read failed (500)",
      ...extra,
    };
    await expect(run()).rejects.toBeInstanceOf(EngineError);
  });

  it("ignores a profile sentence that has no errorData", async () => {
    fetchFake.status = {
      error:
        "Failed to scrape the content, err: Error: Profile load failed because the saved profile snapshot is invalid. The profile may need to be re-saved.",
      ...extra,
    };
    await expect(run()).rejects.toBeInstanceOf(EngineError);
  });

  it("ignores a different errorData code", async () => {
    fetchFake.status = {
      error: "Failed to scrape the content",
      errorData: { code: "INTERNAL_ERROR", message: "nope", details: {} },
      ...extra,
    };
    await expect(run()).rejects.toBeInstanceOf(EngineError);
  });
});

describe("ScrapeProfileError", () => {
  it.each([
    [
      "load",
      "UNAVAILABLE",
      503,
      503,
      "Profile load failed because profile storage was unavailable. Retry the scrape.",
    ],
    [
      "load",
      "NOT_CONFIGURED",
      undefined,
      500,
      "Profile load failed because profile storage is not configured.",
    ],
    [
      "load",
      "HTTP_STATUS",
      409,
      422,
      "Profile load failed (HTTP 409). The profile may need to be re-saved.",
    ],
    [
      "load",
      "TOO_LARGE",
      undefined,
      422,
      "Profile load failed because the saved profile exceeds 16 MiB. The profile may need to be re-saved.",
    ],
    [
      "load",
      "INVALID_JSON",
      undefined,
      422,
      "Profile load failed because the saved profile is not valid JSON. The profile may need to be re-saved.",
    ],
    [
      "load",
      "INVALID_SNAPSHOT",
      undefined,
      422,
      "Profile load failed because the saved profile snapshot is invalid. The profile may need to be re-saved.",
    ],
    [
      "load",
      "INVALID_REFERENCE",
      undefined,
      422,
      "Profile load failed because the profile reference is invalid.",
    ],
    [
      "restore",
      "COOKIES",
      undefined,
      422,
      "Profile restore failed while applying cookies. The profile may need to be re-saved.",
    ],
    [
      "restore",
      "ORIGIN",
      undefined,
      422,
      "Profile restore failed while restoring an origin. The profile may need to be re-saved.",
    ],
    [
      "restore",
      "STORAGE",
      undefined,
      422,
      "Profile restore failed while restoring storage. The profile may need to be re-saved.",
    ],
    [
      "restore",
      "TIMEOUT",
      undefined,
      422,
      "Profile restore failed because it timed out. The profile may need to be re-saved.",
    ],
    [
      "restore",
      "CDP",
      undefined,
      422,
      "Profile restore failed while preparing the browser. The profile may need to be re-saved.",
    ],
    [
      "load",
      "FUTURE_REASON",
      undefined,
      422,
      "Profile load failed. The profile may need to be re-saved.",
    ],
    [
      "NEW_STEP",
      "FUTURE_REASON",
      undefined,
      422,
      "The saved profile could not be used. The profile may need to be re-saved.",
    ],
  ] as const)("maps %s/%s", (step, reason, statusCode, httpStatus, message) => {
    const error = new ScrapeProfileError(step, reason, statusCode);
    expect(error.httpStatus()).toBe(httpStatus);
    expect(error.message).toBe(message);
    expect(error.code).toBe("SCRAPE_PROFILE_ERROR");
  });

  it("round-trips through the worker error transport", () => {
    const error = new ScrapeProfileError("load", "HTTP_STATUS", 404);
    const revived = deserializeTransportableError(
      serializeTransportableError(error),
    );
    expect(revived).toBeInstanceOf(ScrapeProfileError);
    expect(revived).toMatchObject({
      step: "load",
      reason: "HTTP_STATUS",
      statusCode: 404,
      message:
        "Profile load failed (HTTP 404). The profile may need to be re-saved.",
    });
    expect((revived as ScrapeProfileError).httpStatus()).toBe(422);
  });
});
