import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config", () => ({
  config: { USE_DB_AUTHENTICATION: true },
}));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: { warn: vi.fn() },
}));

import { config } from "../../config";
import { getACUCTeam } from "../../controllers/auth";
import { orgIdForTeam } from "../team-org";

const mutableConfig = config as { USE_DB_AUTHENTICATION?: boolean };
const mockedGetACUCTeam = getACUCTeam as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mutableConfig.USE_DB_AUTHENTICATION = true;
});

describe("orgIdForTeam", () => {
  it("answers null without reading the ACUC when DB auth is off", async () => {
    mutableConfig.USE_DB_AUTHENTICATION = false;
    // The mock ACUC's org is the sentinel "bypass"; handing that to Autumn
    // would bill a fake customer where the old lookup failed open.
    mockedGetACUCTeam.mockResolvedValue({
      team_id: "bypass",
      org_id: "bypass",
    });

    expect(await orgIdForTeam("team-1")).toBeNull();
    expect(mockedGetACUCTeam).not.toHaveBeenCalled();
  });

  it("answers null without reading the ACUC for a preview team", async () => {
    mockedGetACUCTeam.mockResolvedValue({
      team_id: "preview_abc",
      org_id: "preview",
    });

    expect(await orgIdForTeam("preview")).toBeNull();
    expect(await orgIdForTeam("preview_abc")).toBeNull();
    expect(mockedGetACUCTeam).not.toHaveBeenCalled();
  });

  it("answers the org on the team's ACUC", async () => {
    mockedGetACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: "org-1" });

    expect(await orgIdForTeam("team-1")).toBe("org-1");
    expect(mockedGetACUCTeam).toHaveBeenCalledWith("team-1");
  });

  it("answers null when the team has no ACUC", async () => {
    mockedGetACUCTeam.mockResolvedValue(null);

    expect(await orgIdForTeam("team-1")).toBeNull();
  });

  it("answers null when the ACUC carries no org", async () => {
    mockedGetACUCTeam.mockResolvedValue({ team_id: "team-1", org_id: null });

    expect(await orgIdForTeam("team-1")).toBeNull();
  });

  it("answers null when the ACUC lookup throws", async () => {
    mockedGetACUCTeam.mockRejectedValue(new Error("acuc unavailable"));

    expect(await orgIdForTeam("team-1")).toBeNull();
  });
});
