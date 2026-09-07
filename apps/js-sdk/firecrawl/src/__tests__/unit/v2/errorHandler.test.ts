import { describe, test, expect } from "@jest/globals";
import { throwForBadResponse, normalizeAxiosError } from "../../../v2/utils/errorHandler";
import { SdkError } from "../../../v2/types";

describe("v2 utils: errorHandler", () => {
  test("throwForBadResponse: throws SdkError with message from body.error", () => {
    const resp: any = { status: 400, data: { error: "bad" } };
    expect(() => throwForBadResponse(resp, "do thing")).toThrow(/bad/);
  });

  test("throwForBadResponse: forwards body.code and body.details", () => {
    const details = {
      browserErrorCode: "ERR_TUNNEL_CONNECTION_FAILED",
      retryable: true,
      origin: "provider_proxy",
    };
    const resp: any = {
      status: 200,
      data: {
        success: false,
        error: "The URL failed to load",
        code: "SCRAPE_SITE_ERROR",
        details,
      },
    };
    try {
      throwForBadResponse(resp, "scrape");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SdkError);
      expect((e as SdkError).code).toBe("SCRAPE_SITE_ERROR");
      expect((e as SdkError).status).toBe(200);
      expect((e as SdkError).details).toEqual(details);
    }
  });

  test("normalizeAxiosError: prefers body.error then err.message", () => {
    const err: any = {
      isAxiosError: true,
      response: { status: 402, data: { error: "payment required" } },
      message: "network",
    };
    expect(() => normalizeAxiosError(err, "action")).toThrow(/payment required/);
  });
});

