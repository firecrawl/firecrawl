import { describe, test, expect } from "@jest/globals";
import { throwForBadResponse, normalizeAxiosError } from "../../../v2/utils/errorHandler";

describe("v2 utils: errorHandler", () => {
  test("throwForBadResponse: throws SdkError with message from body.error", () => {
    const resp: any = { status: 400, data: { error: "bad" } };
    expect(() => throwForBadResponse(resp, "do thing")).toThrow(/bad/);
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

