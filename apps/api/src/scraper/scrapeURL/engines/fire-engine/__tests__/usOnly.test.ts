import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  calls: [] as any[],
  responses: [] as Record<string, unknown>[],
}));

vi.mock("../../../lib/fetch", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/fetch")>()),
  robustFetch: vi.fn(async (params: any) => {
    fake.calls.push(params);
    return fake.responses.shift() ?? {};
  }),
}));

vi.mock("../../../../../lib/gcs-jobs", () => ({
  getDocFromGCS: vi.fn(async () => null),
}));

import { EngineError, UsOnlyUnavailableError } from "../../../error";
import { fireEngineCheckStatus } from "../checkStatus";
import { fireEngineScrape } from "../scrape";
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

function meta(teamFlags?: { usOnly?: boolean }) {
  return {
    id: "scrape-1",
    url: "https://example.com",
    options: {
      formats: [{ type: "markdown" }],
      skipTlsVerification: false,
      proxy: "auto",
    },
    internalOptions: {
      teamId: "team-a",
      zeroDataRetention: false,
      teamFlags,
    },
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

const usOnlyRefusal = {
  error: "US-only exit unavailable: no US exit for this request",
};

const sentRequests = () =>
  fake.calls.filter(call => call.method === "POST").map(call => call.body);

beforeEach(() => {
  fake.calls = [];
  fake.responses = [];
});

describe.each([
  ["chrome-cdp", scrapeURLWithFireEngineChromeCDP],
  ["tlsclient", scrapeURLWithFireEngineTLSClient],
] as const)("fire-engine %s requests", (_, scrapeWith) => {
  it("ask for a US exit for a US-only team and fail closed without one", async () => {
    fake.responses = [usOnlyRefusal];
    await expect(scrapeWith(meta({ usOnly: true }))).rejects.toBeInstanceOf(
      UsOnlyUnavailableError,
    );
    expect(sentRequests()).toEqual([expect.objectContaining({ usOnly: true })]);
  });

  it.each([undefined, { usOnly: false }])(
    "carry no usOnly field for team flags %j",
    async teamFlags => {
      fake.responses = [{ error: "Scrape failed" }];
      await expect(scrapeWith(meta(teamFlags))).rejects.toBeInstanceOf(
        EngineError,
      );
      expect(sentRequests()).toHaveLength(1);
      expect(sentRequests()[0]).not.toHaveProperty("usOnly");
    },
  );
});

describe("a US-only refusal while polling fire-engine", () => {
  it("ends the scrape instead of polling again", async () => {
    fake.responses = [
      { jobId: "job-1", processing: true },
      { jobId: "job-1", state: "failed", processing: false, ...usOnlyRefusal },
    ];
    await expect(
      scrapeURLWithFireEngineChromeCDP(meta({ usOnly: true })),
    ).rejects.toBeInstanceOf(UsOnlyUnavailableError);
    expect(fake.calls.filter(call => call.method === "GET")).toHaveLength(1);
  });
});

describe.each([
  [
    "POST response",
    (m: any) =>
      fireEngineScrape(
        m,
        logger,
        { url: "https://example.com", engine: "chrome-cdp" } as any,
        null,
        undefined,
        "http://fire-engine.test",
      ),
    {},
  ],
  [
    "polled response",
    (m: any) =>
      fireEngineCheckStatus(
        m,
        logger,
        "job-id",
        null,
        undefined,
        "http://fire-engine.test",
      ),
    { jobId: "job-id", state: "failed", processing: false },
  ],
])("fire-engine's US-only refusal in a %s", (_, run, envelope) => {
  it("maps the message to US_ONLY_UNAVAILABLE", async () => {
    fake.responses = [
      { ...envelope, error: "Error: US-only exit unavailable for country nl" },
    ];
    const error = await run(meta({ usOnly: true })).catch(e => e);
    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    expect(error.code).toBe("US_ONLY_UNAVAILABLE");
  });

  it("maps the error code to US_ONLY_UNAVAILABLE", async () => {
    fake.responses = [
      {
        ...envelope,
        error: "Scrape failed",
        errorData: { code: "US_ONLY_EXIT_UNAVAILABLE", message: "No US exit" },
      },
    ];
    await expect(run(meta({ usOnly: true }))).rejects.toBeInstanceOf(
      UsOnlyUnavailableError,
    );
  });

  it("takes precedence over a stealth retry hint", async () => {
    fake.responses = [
      { ...envelope, ...usOnlyRefusal, retryWithStealth: true },
    ];
    await expect(run(meta({ usOnly: true }))).rejects.toBeInstanceOf(
      UsOnlyUnavailableError,
    );
  });

  it("leaves other failures to the existing mapping", async () => {
    fake.responses = [{ ...envelope, error: "Scrape failed" }];
    await expect(run(meta())).rejects.toBeInstanceOf(EngineError);
  });
});
