import { computeGoalVersion } from "./dedupe";

describe("computeGoalVersion", () => {
  it("is stable for the same goal, subject, and queries", () => {
    expect(computeGoalVersion("g", "OpenAI", ["a", "b"])).toBe(
      computeGoalVersion("g", "OpenAI", ["b", "a"]),
    );
  });

  it("changes when the subject (monitor name) changes", () => {
    // Renaming the monitor must invalidate prior judgments even when the goal
    // and queries are unchanged.
    expect(computeGoalVersion("g", "OpenAI", ["a"])).not.toBe(
      computeGoalVersion("g", "Anthropic", ["a"]),
    );
  });

  it("changes when the goal changes", () => {
    expect(computeGoalVersion("g1", "s", ["a"])).not.toBe(
      computeGoalVersion("g2", "s", ["a"]),
    );
  });
});
