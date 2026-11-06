import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../engines", async importOriginal => ({
  ...(await importOriginal<typeof import("../engines")>()),
  buildFallbackList: vi.fn(),
  scrapeURLWithEngine: vi.fn(),
}));

import { scrapeURL } from "..";
import { buildFallbackList, scrapeURLWithEngine } from "../engines";
import { UsOnlyUnavailableError } from "../error";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";

const usOnlyTeam = {
  teamId: "team-a",
  orgId: null,
  teamFlags: { usOnly: true },
};

beforeEach(() => {
  vi.mocked(buildFallbackList).mockReset();
  vi.mocked(scrapeURLWithEngine).mockReset();
});

describe("scrapeURL for US-only teams", () => {
  it("refuses a location outside the US before any engine runs", async () => {
    const result = await scrapeURL(
      "us-only-location",
      "https://example.com",
      scrapeOptions.parse({ location: { country: "NL" } }),
      { ...usOnlyTeam },
      new CostTracking(),
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBeInstanceOf(
      UsOnlyUnavailableError,
    );
    expect(!result.success && result.error.message).toContain(
      'location.country "NL"',
    );
    expect(buildFallbackList).not.toHaveBeenCalled();
    expect(scrapeURLWithEngine).not.toHaveBeenCalled();
  });
});
