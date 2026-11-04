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
    expect(estimateReplayTimeoutSeconds(context({ waitForMs: 60_000 }))).toBe(
      estimateReplayTimeoutSeconds(context({ waitForMs: 30_000 })),
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
    const failure = describeReplayFailure(
      {
        exitCode: 1,
        killed: false,
        stderr:
          "Error: Replay action #2 (click): page.click: Timeout 30000ms exceeded.\n    at <anonymous>:12:3",
      },
      false,
    );
    expect(failure).toEqual({
      exitCode: 1,
      killed: false,
      step: "Replay action #2 (click)",
      detail: expect.stringContaining("Timeout 30000ms exceeded"),
    });
  });

  it("recognizes a navigation failure", () => {
    expect(
      describeReplayFailure(
        {
          exitCode: 1,
          killed: false,
          stderr: "Error: Failed to load scrape URL: net::ERR_ABORTED",
        },
        false,
      ).step,
    ).toBe("Failed to load scrape URL");
  });

  it("reports a killed replay without inventing a step", () => {
    expect(
      describeReplayFailure({ exitCode: 137, killed: true, stderr: "" }, false),
    ).toEqual({ exitCode: 137, killed: true });
  });

  it("truncates a long cause", () => {
    const failure = describeReplayFailure(
      {
        exitCode: 1,
        killed: false,
        stderr: `Replay action #1 (click): ${"x".repeat(5_000)}`,
      },
      false,
    );
    expect(failure.detail!.length).toBeLessThanOrEqual(500);
  });

  it("never returns raw stderr for a ZDR session, only the step label", () => {
    const failure = describeReplayFailure(
      {
        exitCode: 1,
        killed: false,
        stderr:
          "Error: Replay action #3 (click): selector #patient-record-4412 not found",
      },
      true,
    );
    expect(failure).toEqual({
      exitCode: 1,
      killed: false,
      step: "Replay action #3 (click)",
    });
    expect(JSON.stringify(failure)).not.toContain("patient-record");
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
