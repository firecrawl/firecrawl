import { describe, expect, it, vi } from "vitest";
import type { ScrapeJobSingleUrls } from "../../types";

const mocks = vi.hoisted(() => ({
  getTeam: vi.fn(),
  isEnabled: vi.fn().mockResolvedValue(true),
  getApiKeyName: vi.fn().mockResolvedValue("production"),
  enqueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: mocks.getTeam,
}));

vi.mock("./store", () => ({
  isOrgSiemLoggingEnabled: mocks.isEnabled,
  getApiKeyName: mocks.getApiKeyName,
}));

vi.mock("./transport", () => ({
  enqueueSiemLoggingEvent: mocks.enqueue,
  enqueueSiemLoggingEvents: vi.fn().mockResolvedValue(undefined),
}));

import { emitScrapeActivityEvent } from "./index";

const job = {
  mode: "single_urls",
  url: "https://example.com",
  team_id: "team-id",
  scrapeOptions: {},
  internalOptions: { teamId: "team-id", orgId: "org-id" },
  origin: "api",
  zeroDataRetention: false,
  apiKeyId: 42,
} as ScrapeJobSingleUrls;

describe("SIEM logging emission", () => {
  it("does not wait for lookups or queue insertion", async () => {
    let resolveTeam!: (value: unknown) => void;
    mocks.getTeam.mockReturnValueOnce(
      new Promise(resolve => {
        resolveTeam = resolve;
      }),
    );

    expect(
      emitScrapeActivityEvent("scrape-id", job, {
        success: true,
        startedAt: 1_000,
        completedAt: 2_000,
      }),
    ).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();

    resolveTeam({
      flags: { siemLogging: true },
      org_id: "org-id",
    });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
  });
});
