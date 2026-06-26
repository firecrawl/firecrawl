import { Logger } from "winston";

import { Meta } from "../..";
import { AddFeatureError, SiteError } from "../../error";
import { MockState } from "../../lib/mock";
import { fireEngineCheckStatus } from "./checkStatus";
import { fireEngineScrape } from "./scrape";

const baseUrl = "http://fire-engine.test";

function makeLogger() {
  const logger = {
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as Logger;
}

function makeMeta(featureFlags: string[] = []) {
  return {
    options: {
      proxy: "auto",
      skipTlsVerification: false,
    },
    featureFlags: new Set(featureFlags),
  } as unknown as Meta;
}

function makeMock(
  url: string,
  method: "GET" | "POST",
  body: Record<string, unknown>,
): MockState {
  return {
    requests: [
      {
        time: 0,
        options: {
          url,
          method,
          ignoreResponse: false,
          ignoreFailure: false,
          tryCount: 3,
        },
        result: {
          status: 200,
          headers: {},
          body: JSON.stringify(body),
        },
      },
    ],
    tracker: {},
  };
}

describe("Fire Engine Chrome proxy errors", () => {
  it("retries immediate scrape tunnel failures with stealth proxy", async () => {
    const mock = makeMock(`${baseUrl}/scrape`, "POST", {
      error:
        "Failed to scrape the content, err: Error: Chrome error: ERR_TUNNEL_CONNECTION_FAILED",
    });

    const error = await fireEngineScrape(
      makeMeta(),
      makeLogger(),
      {
        engine: "chrome-cdp",
        url: "https://www.walmart.ca/en/ip/example/123",
      },
      mock,
      undefined,
      baseUrl,
    ).catch(error => error);

    expect(error).toBeInstanceOf(AddFeatureError);
    expect(error.featureFlags).toEqual(["stealthProxy"]);
  });

  it("retries deferred status proxy connection failures with stealth proxy", async () => {
    const mock = makeMock(`${baseUrl}/scrape/job-1`, "GET", {
      jobId: "job-1",
      state: "failed",
      processing: false,
      error:
        "Failed to scrape the content, err: Error: Chrome error: ERR_PROXY_CONNECTION_FAILED",
    });

    const error = await fireEngineCheckStatus(
      makeMeta(),
      makeLogger(),
      "job-1",
      mock,
      undefined,
      baseUrl,
    ).catch(error => error);

    expect(error).toBeInstanceOf(AddFeatureError);
    expect(error.featureFlags).toEqual(["stealthProxy"]);
  });

  it("does not retry proxy Chrome errors once stealth proxy is already enabled", async () => {
    const mock = makeMock(`${baseUrl}/scrape`, "POST", {
      error:
        "Failed to scrape the content, err: Error: Chrome error: ERR_TUNNEL_CONNECTION_FAILED",
    });

    await expect(
      fireEngineScrape(
        makeMeta(["stealthProxy"]),
        makeLogger(),
        {
          engine: "chrome-cdp",
          url: "https://www.walmart.ca/en/ip/example/123",
        },
        mock,
        undefined,
        baseUrl,
      ),
    ).rejects.toBeInstanceOf(SiteError);
  });
});
