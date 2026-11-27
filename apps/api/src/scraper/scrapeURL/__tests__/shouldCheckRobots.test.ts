import { shouldCheckRobots } from "../shouldCheckRobots";

describe("shouldCheckRobots", () => {
  it("returns false when lockdown is true, even if checkRobotsOnScrape is set", () => {
    expect(
      shouldCheckRobots({ lockdown: true }, { checkRobotsOnScrape: true }),
    ).toBe(false);
    expect(
      shouldCheckRobots(
        { lockdown: false },
        { checkRobotsOnScrape: true, lockdown: true },
      ),
    ).toBe(false);
  });

  it("returns false when checkRobotsOnScrape is off, regardless of lockdown", () => {
    expect(
      shouldCheckRobots({ lockdown: false }, { checkRobotsOnScrape: false }),
    ).toBe(false);
    expect(shouldCheckRobots({ lockdown: true }, {})).toBe(false);
  });

  it("returns false when ctx is missing or empty", () => {
    expect(shouldCheckRobots({ lockdown: false }, {})).toBe(false);
    expect(shouldCheckRobots({ lockdown: false })).toBe(false);
  });

  it("returns true only when checkRobotsOnScrape is on and lockdown is off", () => {
    expect(
      shouldCheckRobots({ lockdown: false }, { checkRobotsOnScrape: true }),
    ).toBe(true);
    expect(
      shouldCheckRobots(
        { lockdown: false },
        { flags: { checkRobotsOnScrape: true } },
      ),
    ).toBe(true);
  });
});
