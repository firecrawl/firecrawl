import {
  buildReplayContextFromScrape,
  buildReplayScript,
  describeReplayFailure,
  estimateReplayTimeoutSeconds,
  type ScrapeReplayContext,
} from "./scrape-replay";

const context = (
  overrides: Partial<ScrapeReplayContext> = {},
): ScrapeReplayContext => ({
  targetUrl: "https://example.com",
  waitForMs: 0,
  actions: [],
  ...overrides,
});

describe("estimateReplayTimeoutSeconds", () => {
  it("keeps the 45 second margin for a plain replay", () => {
    expect(estimateReplayTimeoutSeconds(context())).toBe(45);
  });

  it("budgets waitFor at the 30 second ceiling the replay script enforces", () => {
    // The generated script runs waitForTimeout(Math.min(waitForMs, 30000)),
    // so a 60 second waitFor must not buy extra kill-deadline headroom.
    // 30s waitFor ceiling + 45s margin. Asserting the number (not just that
    // 60s equals 30s) so a budget that ignores waitFor entirely (45s) fails.
    expect(estimateReplayTimeoutSeconds(context({ waitForMs: 60_000 }))).toBe(
      75,
    );
    expect(estimateReplayTimeoutSeconds(context({ waitForMs: 30_000 }))).toBe(
      75,
    );
    expect(buildReplayScript(context())).toContain(
      "Math.min(replay.waitForMs, 30000)",
    );
  });

  it("budgets a selector wait at the 60 second timeout the replay script uses", () => {
    const script = buildReplayScript(
      context({ actions: [{ type: "wait", selector: "#late" }] }),
    );
    expect(script).toContain("{ timeout: 60000 }");
    // 60s selector budget + 45s margin.
    expect(
      estimateReplayTimeoutSeconds(
        context({ actions: [{ type: "wait", selector: "#late" }] }),
      ),
    ).toBe(105);
  });

  it("adds millisecond waits and selector waits together", () => {
    expect(
      estimateReplayTimeoutSeconds(
        context({
          waitForMs: 10_000,
          actions: [
            { type: "wait", milliseconds: 5_000 },
            { type: "wait", selector: "#a" },
          ],
        }),
      ),
    ).toBe(Math.ceil((10_000 + 5_000 + 60_000 + 45_000) / 1000));
  });

  it("never exceeds the 300 second interact execution ceiling", () => {
    expect(
      estimateReplayTimeoutSeconds(
        context({
          actions: Array.from({ length: 10 }, () => ({
            type: "wait" as const,
            selector: "#x",
          })),
        }),
      ),
    ).toBe(300);
  });
});

describe("describeReplayFailure", () => {
  it("extracts the failing action step and the cause", () => {
    const failure = describeReplayFailure({
      exitCode: 1,
      killed: false,
      stderr:
        "Error: Replay action #2 (click): page.click: Timeout 30000ms exceeded.\n    at <anonymous>:12:3",
    });
    expect(failure).toEqual({
      exitCode: 1,
      killed: false,
      step: "Replay action #2 (click)",
      detail: expect.stringContaining("Timeout 30000ms exceeded"),
    });
  });

  it("recognizes a navigation failure", () => {
    expect(
      describeReplayFailure({
        exitCode: 1,
        killed: false,
        stderr: "Error: Failed to load scrape URL: net::ERR_ABORTED",
      }).step,
    ).toBe("Failed to load scrape URL");
  });

  it("reports a killed replay without inventing a step", () => {
    // A killed replay is cut off mid-run, so there is no error text to read a
    // step from. The log still records that it was killed.
    expect(
      describeReplayFailure({ exitCode: 137, killed: true, stderr: "" }),
    ).toEqual({ exitCode: 137, killed: true });
  });

  it("truncates a long cause to exactly 500 characters", () => {
    const prefix = "Replay action #1 (click): ";
    const failure = describeReplayFailure({
      exitCode: 1,
      killed: false,
      stderr: `${prefix}${"x".repeat(5_000)}`,
    });
    expect(failure.step).toBe("Replay action #1 (click)");
    expect(failure.detail).toHaveLength(500);
    expect(failure.detail).toBe(`${prefix}${"x".repeat(500 - prefix.length)}`);
  });
});

describe("buildReplayContextFromScrape", () => {
  it("still builds the context from stored scrape options", () => {
    expect(
      buildReplayContextFromScrape({
        id: "s",
        team_id: "t",
        url: "https://example.com/a",
        options: {
          waitFor: 1500,
          actions: [{ type: "wait", milliseconds: 10 }],
        },
      }).context,
    ).toEqual({
      targetUrl: "https://example.com/a",
      waitForMs: 1500,
      actions: [{ type: "wait", milliseconds: 10 }],
    });
  });
});
