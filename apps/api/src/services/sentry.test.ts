import { vi } from "vitest";

// vi.mock is hoisted to the top of the file, so anything its factories reference
// must be created in vi.hoisted() (which also hoists). Under Jest these worked
// because importing `jest` from @jest/globals disables jest.mock hoisting.
const { captureException, init, setTag, scopeSetExtra, scopeSetTag } = vi.hoisted(
  () => ({
    captureException: vi.fn(),
    init: vi.fn(),
    setTag: vi.fn(),
    scopeSetExtra: vi.fn(),
    scopeSetTag: vi.fn(),
  }),
);

vi.mock("@sentry/node", () => ({
  captureException,
  getCurrentScope: () => ({
    setExtra: scopeSetExtra,
    setTag: scopeSetTag,
  }),
  init,
  setTag,
  vercelAIIntegration: vi.fn(() => ({})),
}));

vi.mock("../config", () => ({
  config: {
    NUQ_POD_NAME: "test-pod",
    SENTRY_DSN: undefined,
    SENTRY_ENVIRONMENT: "test",
    SENTRY_ERROR_SAMPLE_RATE: 1,
    SENTRY_TRACE_SAMPLE_RATE: 0,
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
  },
}));

vi.mock("../scraper/scrapeURL/error", () => ({
  AddFeatureError: class AddFeatureError extends Error {},
  RemoveFeatureError: class RemoveFeatureError extends Error {},
  EngineError: class EngineError extends Error {},
}));

vi.mock("../scraper/scrapeURL/lib/abortManager", () => ({
  AbortManagerThrownError: class AbortManagerThrownError extends Error {},
}));

vi.mock("../lib/error", () => ({
  JobCancelledError: class JobCancelledError extends Error {},
}));

import { QueueFullError } from "../lib/queue-full-error";
import {
  captureExceptionWithZdrCheck,
  shouldIgnoreSentryException,
} from "./sentry";

describe("sentry filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not capture queue full errors", () => {
    captureExceptionWithZdrCheck(new QueueFullError(50000, 50000));

    expect(captureException).not.toHaveBeenCalled();
  });

  it("recognizes Sentry exception payloads for queue full errors", () => {
    expect(
      shouldIgnoreSentryException({
        type: "QueueFullError",
        value:
          "Queue limit reached: your team has 50000 jobs queued (limit: 50000).",
      }),
    ).toBe(true);
  });

  it("recognizes serialized transportable errors in Sentry exception values", () => {
    expect(
      shouldIgnoreSentryException({
        type: "Error",
        value: 'SCRAPE_TIMEOUT|{"message":"timeout"}',
      }),
    ).toBe(true);
  });

  it("recognizes actions-not-supported Sentry exception values", () => {
    expect(
      shouldIgnoreSentryException({
        type: "Error",
        value:
          'SCRAPE_ACTIONS_NOT_SUPPORTED|{"message":"Actions are not supported by any available engines. Actions require Fire Engine (fire-engine) to be enabled."}',
      }),
    ).toBe(true);
  });

  it("recognizes cancellation errors in Sentry exception values", () => {
    expect(
      shouldIgnoreSentryException({
        type: "Error",
        value: "Parent crawl/batch scrape was cancelled",
      }),
    ).toBe(true);
  });

  it("does not ignore unexpected Sentry exception values", () => {
    expect(
      shouldIgnoreSentryException({
        type: "Error",
        value: "boom",
      }),
    ).toBe(false);
  });

  it("still captures unexpected errors", () => {
    const error = new Error("boom");

    captureExceptionWithZdrCheck(error, {
      tags: { module: "test" },
      zeroDataRetention: false,
    });

    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { module: "test" },
    });
  });
});
