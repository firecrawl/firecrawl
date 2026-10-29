import { describe, expect, it } from "vitest";
import { isSdkOrigin } from "./sdk-origin";

describe("isSdkOrigin", () => {
  it.each([
    "python-sdk@4.52.0",
    "js-sdk@4.48.0",
    "python-sdk.some-agent@4.52.0",
    "js-sdk.scope-name@4.48.0",
  ])("accepts %s", origin => {
    expect(isSdkOrigin(origin)).toBe(true);
  });

  it.each([
    "api",
    "website",
    "mcp-server",
    "go-sdk@1.0.0",
    "xpython-sdk@1.0.0",
    "python-sdkx@1.0.0",
  ])("rejects %s", origin => {
    expect(isSdkOrigin(origin)).toBe(false);
  });
});
