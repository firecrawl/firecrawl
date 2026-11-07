import { describe, it, expect } from "vitest";
import { shouldSuppressForNoise } from "./monitoring_slack";
import type { MonitorCheckRow, MonitorRow } from "../monitoring/types";

type Page = {
  url: string;
  status: string;
  judgment?: {
    meaningful: boolean;
    confidence: "high" | "medium" | "low";
    reason: string;
  } | null;
};

function monitor(overrides: Partial<MonitorRow> = {}): MonitorRow {
  return {
    judge_enabled: true,
    goal: "track prices",
    ...overrides,
  } as MonitorRow;
}

function check(overrides: Partial<MonitorCheckRow> = {}): MonitorCheckRow {
  return {
    changed_count: 0,
    new_count: 0,
    removed_count: 0,
    error_count: 0,
    ...overrides,
  } as MonitorCheckRow;
}

const noise = (url: string): Page => ({
  url,
  status: "changed",
  judgment: { meaningful: false, confidence: "high", reason: "noise" },
});

describe("shouldSuppressForNoise (slack)", () => {
  it("suppresses when all changed pages are noise and no other activity", () => {
    expect(
      shouldSuppressForNoise(monitor(), check({ changed_count: 2 }), [
        noise("u1"),
        noise("u2"),
      ]),
    ).toBe(true);
  });

  it("does NOT suppress when counters report new pages beyond the truncated list", () => {
    // The 100-page window the runner passes shows only noisy changed pages, but
    // the authoritative counters report new pages that were truncated out — the
    // alert must still fire.
    expect(
      shouldSuppressForNoise(
        monitor(),
        check({ changed_count: 2, new_count: 5 }),
        [noise("u1"), noise("u2")],
      ),
    ).toBe(false);
  });

  it("does not suppress when error activity exists beyond the truncated list", () => {
    expect(
      shouldSuppressForNoise(
        monitor(),
        check({ changed_count: 2, error_count: 3 }),
        [noise("u1"), noise("u2")],
      ),
    ).toBe(false);
  });

  it("does not suppress when the changed list is truncated", () => {
    expect(
      shouldSuppressForNoise(monitor(), check({ changed_count: 50 }), [
        noise("u1"),
      ]),
    ).toBe(false);
  });

  it("does not suppress when a changed page is meaningful", () => {
    expect(
      shouldSuppressForNoise(monitor(), check({ changed_count: 1 }), [
        {
          url: "u1",
          status: "changed",
          judgment: { meaningful: true, confidence: "high", reason: "real" },
        },
      ]),
    ).toBe(false);
  });

  it("does not gate when judging is disabled", () => {
    expect(
      shouldSuppressForNoise(
        monitor({ judge_enabled: false }),
        check({ changed_count: 1 }),
        [noise("u1")],
      ),
    ).toBe(false);
  });
});
