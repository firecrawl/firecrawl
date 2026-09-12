import { describe, expect, it } from "vitest";
import type { Meta } from "..";
import type { Engine, FeatureFlag } from "../engines";
import { shouldEscalateToStealthProxy } from "./stealthEscalation";

function makeMeta({
  proxy,
  flags = [],
  forceEngine,
}: {
  proxy: "auto" | "basic" | "stealth" | "enhanced";
  flags?: FeatureFlag[];
  forceEngine?: Engine | Engine[];
}): Meta {
  return {
    options: { proxy },
    featureFlags: new Set(flags),
    internalOptions: { forceEngine },
  } as unknown as Meta;
}

describe("shouldEscalateToStealthProxy", () => {
  it("escalates for auto proxy", () => {
    expect(shouldEscalateToStealthProxy(makeMeta({ proxy: "auto" }))).toBe(
      true,
    );
  });

  it("escalates when several engines are forced", () => {
    expect(
      shouldEscalateToStealthProxy(
        makeMeta({ proxy: "auto", forceEngine: ["fetch", "playwright"] }),
      ),
    ).toBe(true);
  });

  it("does not escalate when stealth is already in use", () => {
    expect(
      shouldEscalateToStealthProxy(
        makeMeta({ proxy: "auto", flags: ["stealthProxy"] }),
      ),
    ).toBe(false);
  });

  it("does not escalate when a single engine is pinned", () => {
    expect(
      shouldEscalateToStealthProxy(
        makeMeta({ proxy: "auto", forceEngine: "fetch" }),
      ),
    ).toBe(false);
  });

  it("does not escalate for non-auto proxies", () => {
    expect(shouldEscalateToStealthProxy(makeMeta({ proxy: "basic" }))).toBe(
      false,
    );
  });
});
