import { shouldCheckRobots } from "../shouldCheckRobots";

describe("shouldCheckRobots", () => {
  it("returns false when lockdown is true, even if the team flag is set", () => {
    expect(
      shouldCheckRobots(
        { lockdown: true },
        { teamFlags: { checkRobotsOnScrape: true } as any },
      ),
    ).toBe(false);
  });

  it("returns false when the team flag is off, regardless of lockdown", () => {
    expect(
      shouldCheckRobots(
        { lockdown: false },
        { teamFlags: { checkRobotsOnScrape: false } as any },
      ),
    ).toBe(false);
    expect(
      shouldCheckRobots({ lockdown: true }, { teamFlags: {} as any }),
    ).toBe(false);
  });

  it("returns false when teamFlags is missing", () => {
    expect(shouldCheckRobots({ lockdown: false }, {})).toBe(false);
  });

  it("returns true only when the team flag is on and lockdown is off", () => {
    expect(
      shouldCheckRobots(
        { lockdown: false },
        { teamFlags: { checkRobotsOnScrape: true } as any },
      ),
    ).toBe(true);
  });
});
