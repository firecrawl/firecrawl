import { describe, expect, it } from "vitest";
import { concurrencyQueueTimeoutMessage } from "./error";
import {
  isAuthenticatedTeamId,
  teamBillingUrl,
  upgradeUrlForTeam,
} from "./team-billing-url";

const TEAM_ID = "55555555-5555-4555-8555-555555555555";

describe("team billing urls", () => {
  it("builds the dashboard billing page from a team uuid", () => {
    expect(teamBillingUrl(TEAM_ID)).toBe(
      `https://www.firecrawl.dev/app/t/${TEAM_ID}/settings?tab=billing`,
    );
    expect(isAuthenticatedTeamId(TEAM_ID)).toBe(true);
    expect(upgradeUrlForTeam(TEAM_ID)).toBe(teamBillingUrl(TEAM_ID));
  });

  it("keeps the public pricing page for callers without a team", () => {
    for (const teamId of [
      null,
      undefined,
      "preview",
      "preview_1.2.3.4",
      "preview_keyless_203.0.113.8",
      "bypass",
      "team_test",
    ]) {
      expect(isAuthenticatedTeamId(teamId)).toBe(false);
      expect(upgradeUrlForTeam(teamId)).toBe("https://firecrawl.dev/pricing");
    }
  });

  it("puts the team billing page in a concurrency timeout for a real team", () => {
    expect(concurrencyQueueTimeoutMessage(TEAM_ID)).toContain(
      teamBillingUrl(TEAM_ID),
    );
    expect(
      concurrencyQueueTimeoutMessage("preview_keyless_203.0.113.8"),
    ).toContain("https://firecrawl.dev/pricing");
  });
});
