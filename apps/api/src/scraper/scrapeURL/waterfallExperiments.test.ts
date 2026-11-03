import { SiteError } from "./error";
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
});

describe("inWaterfallExperimentArm", () => {
  it("is stable per scrape and close to the rollout", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `scrape-${i}`);
    const share =
      ids.filter(id => inWaterfallExperimentArm(id, "tunnel-error-retry"))
        .length / ids.length;
    expect(inWaterfallExperimentArm("scrape-1", "tunnel-error-retry")).toBe(
      inWaterfallExperimentArm("scrape-1", "tunnel-error-retry"),
    );
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
  });
});
