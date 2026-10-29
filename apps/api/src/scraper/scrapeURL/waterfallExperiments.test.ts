import { AddFeatureError, EngineError, SiteError } from "./error";
import {
  inWaterfallExperimentArm,
  waterfallExperimentFor,
} from "./waterfallExperiments";

describe("waterfallExperimentFor", () => {
  it("takes a tunnel error on a first attempt that has its retry engine next", () => {
    const error = new SiteError("net::ERR_TUNNEL_CONNECTION_FAILED");
    expect(
      waterfallExperimentFor(
        "fire-engine;chrome-cdp",
        error,
        "fire-engine(retry);chrome-cdp",
      ),
    ).toBe("tunnel-error-retry");
    expect(
      waterfallExperimentFor(
        "fire-engine;chrome-cdp;stealth",
        error,
        "fire-engine(retry);chrome-cdp;stealth",
      ),
    ).toBe("tunnel-error-retry");
    expect(
      waterfallExperimentFor("fire-engine(retry);chrome-cdp", error, undefined),
    ).toBeUndefined();
    expect(
      waterfallExperimentFor(
        "fire-engine;chrome-cdp",
        new SiteError("ERR_CONNECTION_REFUSED"),
        "fire-engine(retry);chrome-cdp",
      ),
    ).toBeUndefined();
  });

  it("takes a site_protection failure on the first enhanced attempt", () => {
    const blocked = new EngineError("Scrape job failed", {
      cause: { status: { failureReason: "site_protection" } },
    });
    expect(
      waterfallExperimentFor(
        "fire-engine;chrome-cdp;stealth",
        blocked,
        "fire-engine(retry);chrome-cdp;stealth",
      ),
    ).toBe("skip-enhanced-retry-after-site-protection");
    expect(
      waterfallExperimentFor(
        "fire-engine;chrome-cdp;stealth",
        new EngineError("Scrape job failed", { cause: { status: {} } }),
        "fire-engine(retry);chrome-cdp;stealth",
      ),
    ).toBeUndefined();
  });

  it("takes a 429 escalation on the first basic attempt only", () => {
    const escalation = (statusCode: number) =>
      Object.assign(new AddFeatureError(["stealthProxy"]), { statusCode });
    expect(
      waterfallExperimentFor(
        "fire-engine;chrome-cdp",
        escalation(429),
        "fire-engine(retry);chrome-cdp",
      ),
    ).toBe("basic-retry-on-429");
    expect(
      waterfallExperimentFor(
        "fire-engine;chrome-cdp",
        escalation(403),
        "fire-engine(retry);chrome-cdp",
      ),
    ).toBeUndefined();
    expect(
      waterfallExperimentFor(
        "fire-engine(retry);chrome-cdp",
        escalation(429),
        "fire-engine;chrome-cdp;stealth",
      ),
    ).toBeUndefined();
  });
});

describe("inWaterfallExperimentArm", () => {
  it("is stable per scrape and close to the rollout", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `scrape-${i}`);
    const share = (
      experiment: Parameters<typeof inWaterfallExperimentArm>[1],
    ) =>
      ids.filter(id => inWaterfallExperimentArm(id, experiment)).length /
      ids.length;
    expect(inWaterfallExperimentArm("scrape-1", "tunnel-error-retry")).toBe(
      inWaterfallExperimentArm("scrape-1", "tunnel-error-retry"),
    );
    expect(share("tunnel-error-retry")).toBeGreaterThan(0.45);
    expect(share("tunnel-error-retry")).toBeLessThan(0.55);
    expect(share("skip-enhanced-retry-after-site-protection")).toBeGreaterThan(
      0.16,
    );
    expect(share("skip-enhanced-retry-after-site-protection")).toBeLessThan(
      0.24,
    );
  });
});
