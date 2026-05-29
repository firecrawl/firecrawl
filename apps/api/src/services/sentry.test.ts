import { jest } from "@jest/globals";

const captureException = jest.fn();
const init = jest.fn();
const setTag = jest.fn();
const scopeSetExtra = jest.fn();
const scopeSetTag = jest.fn();

jest.mock("@sentry/node", () => ({
  captureException,
  getCurrentScope: () => ({
    setExtra: scopeSetExtra,
    setTag: scopeSetTag,
  }),
  init,
  setTag,
  vercelAIIntegration: jest.fn(() => ({})),
}));

jest.mock("../config", () => ({
  config: {
    NUQ_POD_NAME: "test-pod",
    SENTRY_DSN: undefined,
    SENTRY_ENVIRONMENT: "test",
    SENTRY_ERROR_SAMPLE_RATE: 1,
    SENTRY_TRACE_SAMPLE_RATE: 0,
  },
}));

jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
  },
}));

class AddFeatureError extends Error {}
class RemoveFeatureError extends Error {}
class EngineError extends Error {}
class AbortManagerThrownError extends Error {}
class JobCancelledError extends Error {}

jest.mock("../scraper/scrapeURL/error", () => ({
  AddFeatureError,
  RemoveFeatureError,
  EngineError,
}));

jest.mock("../scraper/scrapeURL/lib/abortManager", () => ({
  AbortManagerThrownError,
}));

jest.mock("../lib/error", () => ({
  JobCancelledError,
}));

import { QueueFullError } from "../lib/queue-full-error";
import {
  captureExceptionWithZdrCheck,
  shouldIgnoreSentryException,
} from "./sentry";

describe("sentry filtering", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
