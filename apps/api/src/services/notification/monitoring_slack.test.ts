const { mockGetInstallation, mockDecrypt, mockPost, mockJoin } = vi.hoisted(
  () => ({
    mockGetInstallation: vi.fn(),
    mockDecrypt: vi.fn(),
    mockPost: vi.fn(),
    mockJoin: vi.fn(),
  }),
);

vi.mock("../integrations/slack/store", () => ({
  getSlackInstallationByTeam: (...args: unknown[]) =>
    mockGetInstallation(...args),
}));

vi.mock("../integrations/slack/crypto", () => ({
  decryptSlackToken: (...args: unknown[]) => mockDecrypt(...args),
}));

vi.mock("../integrations/slack/client", () => ({
  postSlackMessage: (...args: unknown[]) => mockPost(...args),
  joinChannel: (...args: unknown[]) => mockJoin(...args),
}));

import { describe, it, expect } from "vitest";
import {
  sendMonitoringSlackSummary,
  shouldSuppressForNoise,
} from "./monitoring_slack";
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

function page(
  url: string,
  status: string,
  meaningful: boolean | null,
  reason = "because",
): Page {
  return {
    url,
    status,
    judgment:
      meaningful === null ? null : { meaningful, confidence: "high", reason },
  };
}

function slackMonitor(overrides: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: "monitor-1",
    team_id: "team-1",
    name: "Docs monitor",
    judge_enabled: true,
    goal: "track prices",
    notification: { slack: { enabled: true, channelId: "C123" } },
    ...overrides,
  } as MonitorRow;
}

function slackCheck(overrides: Partial<MonitorCheckRow> = {}): MonitorCheckRow {
  return {
    id: "check-1",
    changed_count: 0,
    new_count: 0,
    removed_count: 0,
    error_count: 0,
    total_pages: 4,
    actual_credits: 1,
    ...overrides,
  } as MonitorCheckRow;
}

function postedText(): string {
  expect(mockPost).toHaveBeenCalledTimes(1);
  const payload = mockPost.mock.calls[0][0] as {
    text: string;
    blocks: unknown[];
  };
  return JSON.stringify({ text: payload.text, blocks: payload.blocks });
}

describe("sendMonitoringSlackSummary page list", () => {
  beforeEach(() => {
    mockGetInstallation.mockReset();
    mockDecrypt.mockReset();
    mockPost.mockReset();
    mockJoin.mockReset();
    mockGetInstallation.mockResolvedValue({ bot_token: "enc" });
    mockDecrypt.mockReturnValue("xoxb-test");
    mockPost.mockResolvedValue({ ok: true });
    mockJoin.mockResolvedValue({ ok: true });
  });

  it("drops noise-judged changed pages from a mixed alert and labels the gap", async () => {
    const result = await sendMonitoringSlackSummary({
      monitor: slackMonitor(),
      check: slackCheck({
        changed_count: 3,
        new_count: 1,
        removed_count: 1,
        error_count: 1,
      }),
      pages: [
        page("https://example.com/price", "changed", true, "Pro price changed"),
        page(
          "https://example.com/clock",
          "changed",
          false,
          "Only the timestamp moved",
        ),
        page("https://example.com/unjudged", "changed", null),
        page(
          "https://example.com/new-page",
          "new",
          false,
          "A new page stays even when judged noise",
        ),
        page(
          "https://example.com/removed-page",
          "removed",
          false,
          "A removed page stays even when judged noise",
        ),
        page(
          "https://example.com/error-page",
          "error",
          false,
          "An error page stays even when judged noise",
        ),
      ],
    });

    expect(result).toMatchObject({ attempted: true, success: true });
    const body = postedText();
    expect(body).toContain("https://example.com/price");
    expect(body).toContain("Pro price changed");
    expect(body).toContain("https://example.com/unjudged");
    expect(body).toContain("https://example.com/new-page");
    expect(body).toContain("A new page stays even when judged noise");
    expect(body).toContain("https://example.com/removed-page");
    expect(body).toContain("A removed page stays even when judged noise");
    expect(body).toContain("https://example.com/error-page");
    expect(body).toContain("An error page stays even when judged noise");
    expect(body).not.toContain("https://example.com/clock");
    expect(body).not.toContain("Only the timestamp moved");
    expect(body).toContain("3 changed (1 meaningful, 1 noise omitted)");
    expect(body).toContain("1 new");
    expect(body).toContain("1 removed");
    expect(body).toContain("1 error");
  });

  it("does not post when every changed page is noise and nothing else happened", async () => {
    const result = await sendMonitoringSlackSummary({
      monitor: slackMonitor(),
      check: slackCheck({ changed_count: 2 }),
      pages: [
        page("https://example.com/clock", "changed", false, "timestamp"),
        page("https://example.com/ads", "changed", false, "ad rotation"),
      ],
    });

    expect(result).toMatchObject({ attempted: false, success: true });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("still posts noise pages when judging is disabled", async () => {
    const result = await sendMonitoringSlackSummary({
      monitor: slackMonitor({ judge_enabled: false }),
      check: slackCheck({ changed_count: 1 }),
      pages: [
        page(
          "https://example.com/clock",
          "changed",
          false,
          "Only the timestamp moved",
        ),
      ],
    });

    expect(result.attempted).toBe(true);
    const body = postedText();
    expect(body).toContain("https://example.com/clock");
    expect(body).toContain("Only the timestamp moved");
    expect(body).toContain("1 changed");
    expect(body).not.toContain("noise omitted");
  });

  it("still posts noise pages when the goal is empty", async () => {
    const result = await sendMonitoringSlackSummary({
      monitor: slackMonitor({ goal: "" }),
      check: slackCheck({ changed_count: 1 }),
      pages: [page("https://example.com/clock", "changed", false, "timestamp")],
    });

    expect(result.attempted).toBe(true);
    const body = postedText();
    expect(body).toContain("https://example.com/clock");
    expect(body).not.toContain("noise omitted");
  });

  it("keeps an unjudged changed page", async () => {
    const result = await sendMonitoringSlackSummary({
      monitor: slackMonitor(),
      check: slackCheck({ changed_count: 1 }),
      pages: [page("https://example.com/unjudged", "changed", null)],
    });

    expect(result.attempted).toBe(true);
    const body = postedText();
    expect(body).toContain("https://example.com/unjudged");
    expect(body).not.toContain("noise omitted");
    expect(body).toContain("1 changed");
  });

  it("omits a noise page list when the only rows in hand are noise but other activity remains", async () => {
    const result = await sendMonitoringSlackSummary({
      monitor: slackMonitor(),
      check: slackCheck({ changed_count: 1, new_count: 2 }),
      pages: [
        page(
          "https://example.com/clock",
          "changed",
          false,
          "Only the timestamp moved",
        ),
      ],
    });

    expect(result.attempted).toBe(true);
    const body = postedText();
    expect(body).not.toContain("https://example.com/clock");
    expect(body).not.toContain("Only the timestamp moved");
    expect(body).toContain("1 changed (1 noise omitted)");
    expect(body).toContain("2 new");
  });

  it("does not quote a window noise count against the full changed total", async () => {
    const result = await sendMonitoringSlackSummary({
      monitor: slackMonitor(),
      check: slackCheck({ changed_count: 50, new_count: 1 }),
      pages: [
        page("https://example.com/price", "changed", true, "Pro price changed"),
        page(
          "https://example.com/clock",
          "changed",
          false,
          "Only the timestamp moved",
        ),
        page("https://example.com/new-page", "new", false, "Still listed"),
      ],
    });

    expect(result.attempted).toBe(true);
    const body = postedText();
    expect(body).toContain("https://example.com/price");
    expect(body).toContain("https://example.com/new-page");
    expect(body).not.toContain("https://example.com/clock");
    expect(body).toContain("50 changed (1 meaningful)");
    expect(body).not.toContain("noise omitted");
    expect(body).not.toContain("0 noise");
  });
});
