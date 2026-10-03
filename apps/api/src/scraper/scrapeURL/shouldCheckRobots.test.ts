import { shouldCheckRobots } from "./shouldCheckRobots";

describe("shouldCheckRobots", () => {
  it("never checks under lockdown, even with safe mode enforcing robots", () => {
    expect(
      shouldCheckRobots(
        { lockdown: true },
        { safeMode: { enforceRobots: true } as any },
      ),
    ).toBe(false);
  });

  it("checks when the team flag opts in", () => {
    expect(
      shouldCheckRobots({}, { teamFlags: { checkRobotsOnScrape: true } }),
    ).toBe(true);
  });

  it("checks when safe mode enforces robots, regardless of the team flag", () => {
    expect(
      shouldCheckRobots({}, { safeMode: { enforceRobots: true } as any }),
    ).toBe(true);
    expect(
      shouldCheckRobots(
        {},
        {
          teamFlags: { checkRobotsOnScrape: false },
          safeMode: { enforceRobots: true } as any,
        },
      ),
    ).toBe(true);
  });

  it("does not check when safe mode relaxes robots and the flag is off", () => {
    expect(
      shouldCheckRobots({}, { safeMode: { enforceRobots: false } as any }),
    ).toBe(false);
  });

  it("does not check when neither opts in", () => {
    expect(shouldCheckRobots({}, {})).toBe(false);
    expect(
      shouldCheckRobots({}, { teamFlags: { checkRobotsOnScrape: false } }),
    ).toBe(false);
  });
});
