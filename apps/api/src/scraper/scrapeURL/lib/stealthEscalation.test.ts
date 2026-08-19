import { describe, expect, it } from "vitest";
import type { Meta } from "..";
import type { FeatureFlag } from "../engines";
import { shouldEscalateToStealthProxy } from "./stealthEscalation";

function makeMeta({
  proxy,
  flags = [],
}: {
  proxy: "auto" | "basic" | "stealth" | "enhanced";
  flags?: FeatureFlag[];
}): Meta {
  return {
    options: { proxy },
    featureFlags: new Set(flags),
  } as unknown as Meta;
}

describe("shouldEscalateToStealthProxy", () => {
  it("escalates for auto proxy", () => {
    expect(shouldEscalateToStealthProxy(makeMeta({ proxy: "auto" }))).toBe(
      true,
    );
  });

  it("does not escalate when stealth is already in use", () => {
    expect(
      shouldEscalateToStealthProxy(
        makeMeta({ proxy: "auto", flags: ["stealthProxy"] }),
      ),
    ).toBe(false);
  });

  it("does not escalate for non-auto proxies", () => {
    expect(shouldEscalateToStealthProxy(makeMeta({ proxy: "basic" }))).toBe(
      false,
    );
  });
});
