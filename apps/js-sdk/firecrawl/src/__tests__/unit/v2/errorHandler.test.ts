import { describe, test, expect } from "vitest";
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

  test("normalizeAxiosError: names the fields a 400 validation error rejected", () => {
    const err: any = {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: "Unrecognized key in body -- please review the v2 API documentation for request body changes",
          details: [{ code: "unrecognized_keys", keys: ["parsePDF"], path: [], message: "Unrecognized key(s) in object: 'parsePDF'" }],
        },
      },
      message: "Request failed with status code 400",
    };
    expect(() => normalizeAxiosError(err, "scrape")).toThrow(/unrecognized key\(s\) parsePDF/);
  });

  test("throwForBadResponse: appends the path and message of each issue", () => {
    const resp: any = {
      status: 400,
      data: { error: "Bad Request", details: [{ code: "invalid_union", path: ["formats", 0], message: "Invalid input" }] },
    };
    expect(() => throwForBadResponse(resp, "scrape")).toThrow("Bad Request (formats.0: Invalid input)");
  });
});

