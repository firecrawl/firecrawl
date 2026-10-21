import { describe, expect, it, vi } from "vitest";

const { values } = vi.hoisted(() => ({ values: vi.fn() }));

vi.mock("../../db/connection", () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => {
        values(row);
        return { returning: async () => [row] };
      },
    }),
  },
}));
vi.mock("../../services/redis", () => ({
  getValue: vi.fn(),
  setValue: vi.fn(),
}));
vi.mock("../../services/rate-limiter", () => ({ redisRateLimitClient: {} }));

import { insertBrowserSession } from "../browser-sessions";
import { keylessTeamUuid } from "../keyless-team";

const row = {
  id: "0199f3a0-0000-7000-8000-000000000001",
  zero_data_retention: false,
  request_id: null,
  should_bill: false,
  browser_id: "br_1",
  workspace_id: "",
  context_id: "",
  cdp_url: "wss://cdp",
  cdp_path: "",
  cdp_interactive_path: "",
  stream_web_view: false,
  status: "active" as const,
  ttl_total: 600,
  ttl_without_activity: null,
  credits_used: null,
};

describe("insertBrowserSession team ids", () => {
  it.each([
    ["an IP keyless caller", "preview_keyless_203.0.113.8"],
    ["a World ID keyless caller", `preview_keyless_wid_${"h".repeat(43)}`],
  ])(
    "keeps the raw id for %s and stores the scrapes uuid beside it",
    async (_, teamId) => {
      await insertBrowserSession({ ...row, team_id: teamId });

      expect(values).toHaveBeenLastCalledWith(
        expect.objectContaining({
          team_id: teamId,
          persisted_team_id: keylessTeamUuid(teamId),
        }),
      );
    },
  );

  it("stores a regular team's uuid unchanged", async () => {
    const teamId = "6d6f2a41-6f5b-4f0e-9a1f-2b3c4d5e6f70";
    await insertBrowserSession({ ...row, team_id: teamId });

    expect(values).toHaveBeenLastCalledWith(
      expect.objectContaining({ team_id: teamId, persisted_team_id: teamId }),
    );
  });

  it("stores no uuid for the self-hosted bypass team", async () => {
    await insertBrowserSession({ ...row, team_id: "bypass" });

    expect(values).toHaveBeenLastCalledWith(
      expect.objectContaining({ team_id: "bypass", persisted_team_id: null }),
    );
  });
});
