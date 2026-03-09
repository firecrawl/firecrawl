import {
  isRobotsVerificationAbortError,
  shouldFailClosedOnInitialRobotsFetch,
  shouldUseJsRobotsFilterPath,
} from "../robots-runtime-policy";
import { AbortManagerThrownError } from "../../scraper/scrapeURL/lib/abortManager";

describe("robots runtime policy helpers", () => {
  it("fails closed only for strict robots mode", () => {
    expect(shouldFailClosedOnInitialRobotsFetch("strict")).toBe(true);
    expect(shouldFailClosedOnInitialRobotsFetch("respect")).toBe(false);
    expect(shouldFailClosedOnInitialRobotsFetch("ignore")).toBe(false);
    expect(shouldFailClosedOnInitialRobotsFetch(undefined)).toBe(false);
  });

  it("uses JS link filtering when a custom user agent needs robots-aware evaluation", () => {
    expect(
      shouldUseJsRobotsFilterPath({
        ignoreRobotsTxt: false,
        skipRobots: false,
        userAgent: "DebTestBot/1.0",
      }),
    ).toBe(true);

    expect(
      shouldUseJsRobotsFilterPath({
        ignoreRobotsTxt: true,
        skipRobots: false,
        userAgent: "DebTestBot/1.0",
      }),
    ).toBe(false);

    expect(
      shouldUseJsRobotsFilterPath({
        ignoreRobotsTxt: false,
        skipRobots: true,
        userAgent: "DebTestBot/1.0",
      }),
    ).toBe(false);

    expect(
      shouldUseJsRobotsFilterPath({
        ignoreRobotsTxt: false,
        skipRobots: false,
        userAgent: undefined,
      }),
    ).toBe(false);
  });

  it("treats abort-shaped errors as cancellation signals", () => {
    expect(
      isRobotsVerificationAbortError(
        new AbortManagerThrownError(
          "external",
          new Error("Robots.txt fetch aborted"),
        ),
      ),
    ).toBe(true);
    expect(
      isRobotsVerificationAbortError(
        Object.assign(new Error("request aborted"), { name: "AbortError" }),
      ),
    ).toBe(true);
    expect(
      isRobotsVerificationAbortError(new Error("Robots.txt fetch aborted")),
    ).toBe(true);
    expect(isRobotsVerificationAbortError(new Error("robots fetch failed"))).toBe(
      false,
    );
  });
});
