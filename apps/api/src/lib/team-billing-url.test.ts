import { afterEach, describe, expect, it } from "vitest";
import { config } from "../config";
import { concurrencyQueueTimeoutMessage } from "./error";
import {
  isAuthenticatedTeamId,
  teamBillingUrl,
  upgradeUrlForTeam,
} from "./team-billing-url";

const TEAM_ID = "55555555-5555-4555-8555-555555555555";
const originalDashboardUrl = config.FIRECRAWL_DASHBOARD_URL;

describe("team billing urls", () => {
  afterEach(() => {
    config.FIRECRAWL_DASHBOARD_URL = originalDashboardUrl;
  });

  it("builds the dashboard billing page from a team uuid", () => {
    config.FIRECRAWL_DASHBOARD_URL = "https://www.firecrawl.dev";
    expect(teamBillingUrl(TEAM_ID)).toBe(
      `https://www.firecrawl.dev/app/t/${TEAM_ID}/settings?tab=billing`,
    );
    expect(isAuthenticatedTeamId(TEAM_ID)).toBe(true);
    expect(upgradeUrlForTeam(TEAM_ID)).toBe(teamBillingUrl(TEAM_ID));
  });

  it("uses the configured dashboard host and strips trailing slashes", () => {
    config.FIRECRAWL_DASHBOARD_URL = "https://staging.example.dev/";
    expect(teamBillingUrl(TEAM_ID)).toBe(
      `https://staging.example.dev/app/t/${TEAM_ID}/settings?tab=billing`,
    );
    expect(upgradeUrlForTeam(TEAM_ID)).toBe(teamBillingUrl(TEAM_ID));

    config.FIRECRAWL_DASHBOARD_URL = "https://dash.example.dev///";
    expect(teamBillingUrl(TEAM_ID)).toBe(
      `https://dash.example.dev/app/t/${TEAM_ID}/settings?tab=billing`,
    );
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
    const message = concurrencyQueueTimeoutMessage(TEAM_ID);
    expect(message).toContain("to increase your concurrency limit");
    expect(message).toContain(teamBillingUrl(TEAM_ID));
    expect(
      concurrencyQueueTimeoutMessage("preview_keyless_203.0.113.8"),
    ).toContain("https://firecrawl.dev/pricing");
  });
});
