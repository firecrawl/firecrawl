import { shouldCheckRobots } from "./shouldCheckRobots";

describe("shouldCheckRobots", () => {
  it("never checks under lockdown, even when checkRobotsOnScrape is set", () => {
    expect(
      shouldCheckRobots({ lockdown: true }, { checkRobotsOnScrape: true }),
    ).toBe(false);
    expect(
      shouldCheckRobots({}, { checkRobotsOnScrape: true, lockdown: true }),
    ).toBe(false);
  });

  it("checks when ctx opts in", () => {
    expect(shouldCheckRobots({}, { checkRobotsOnScrape: true })).toBe(true);
  });

  it("does not check when ctx does not opt in", () => {
    expect(shouldCheckRobots({}, {})).toBe(false);
    expect(shouldCheckRobots({}, { checkRobotsOnScrape: false })).toBe(false);
    expect(shouldCheckRobots({})).toBe(false);
  });
});
