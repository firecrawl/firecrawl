import { describe, expect, it } from "vitest";
import type { Meta } from "..";
import type { Engine, FeatureFlag } from "../engines";
import { canEscalateToStealthProxy } from "./stealthEscalation";

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
    internalOptions: { forceEngine },
    featureFlags: new Set(flags),
  } as unknown as Meta;
}

describe("canEscalateToStealthProxy", () => {
  it("allows escalation for auto proxy without a forced engine", () => {
    expect(canEscalateToStealthProxy(makeMeta({ proxy: "auto" }))).toBe(true);
  });

  it("allows escalation when the forced engine is a retryable list", () => {
    expect(
      canEscalateToStealthProxy(
        makeMeta({
          proxy: "auto",
          forceEngine: ["fire-engine;chrome-cdp", "fire-engine;tlsclient"],
        }),
      ),
    ).toBe(true);
  });

  it("does not escalate when stealth is already in use", () => {
    expect(
      canEscalateToStealthProxy(
        makeMeta({ proxy: "auto", flags: ["stealthProxy"] }),
      ),
    ).toBe(false);
  });

  it("does not escalate when a single engine is pinned", () => {
    expect(
      canEscalateToStealthProxy(
        makeMeta({ proxy: "auto", forceEngine: "fire-engine;chrome-cdp" }),
      ),
    ).toBe(false);
  });

  it("does not escalate for non-auto proxies", () => {
    expect(canEscalateToStealthProxy(makeMeta({ proxy: "basic" }))).toBe(false);
  });
});
