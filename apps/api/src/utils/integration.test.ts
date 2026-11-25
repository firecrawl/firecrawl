import { describe, expect, it } from "vitest";
import { integrationFromHeader, resolveIntegration } from "./integration";

const withHeader = (value?: string) => ({
  headers: value === undefined ? {} : { "x-integration": value },
});

describe("integrationFromHeader", () => {
  it("normalizes a valid header", () => {
    expect(integrationFromHeader(withHeader(" Hermes "))).toBe("hermes");
    expect(integrationFromHeader(withHeader("_rtk"))).toBe("_rtk");
  });

  it("ignores a missing or invalid header", () => {
    expect(integrationFromHeader(withHeader())).toBeUndefined();
    expect(integrationFromHeader(withHeader(""))).toBeUndefined();
    expect(
      integrationFromHeader(withHeader("not a valid tag!")),
    ).toBeUndefined();
  });
});

describe("resolveIntegration", () => {
  it("lets a valid header replace a missing or cli value", () => {
    expect(resolveIntegration(undefined, withHeader("hermes"))).toBe("hermes");
    expect(resolveIntegration(null, withHeader("hermes"))).toBe("hermes");
    expect(resolveIntegration("cli", withHeader("_rtk"))).toBe("_rtk");
  });

  it("keeps any other explicit value over the header", () => {
    expect(resolveIntegration("n8n", withHeader("hermes"))).toBe("n8n");
    expect(resolveIntegration("_custom", withHeader("hermes"))).toBe("_custom");
  });

  it("keeps the explicit value when the header is missing or invalid", () => {
    expect(resolveIntegration("cli", withHeader())).toBe("cli");
    expect(resolveIntegration("cli", withHeader("not a valid tag!"))).toBe(
      "cli",
    );
    expect(resolveIntegration(undefined, withHeader("nope"))).toBeUndefined();
    expect(resolveIntegration(null, withHeader())).toBeNull();
  });
});
