const { readApiJobAccess, replicaSelect } = vi.hoisted(() => ({
  readApiJobAccess: vi.fn(),
  replicaSelect: vi.fn(),
}));

vi.mock("./job-access-store", () => ({ readApiJobAccess }));
vi.mock("../db/connection", () => ({
  db: { select: vi.fn() },
  dbRr: { select: replicaSelect },
}));

import { supabaseGetScrapeByIdOnlyData } from "./supabase-jobs";

describe("operational job access lookup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses an unexpired Bigtable row without querying PostgreSQL", async () => {
    readApiJobAccess.mockResolvedValue({
      teamId: "team-id",
      kind: "scrape",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      supabaseGetScrapeByIdOnlyData("019e6f45-7778-727d-adf0-0abe9d5062b6"),
    ).resolves.toEqual({ team_id: "team-id" });
    expect(replicaSelect).not.toHaveBeenCalled();
  });

  it("falls back to PostgreSQL on a Bigtable miss", async () => {
    readApiJobAccess.mockResolvedValue(null);
    const query = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([{ team_id: "legacy-team" }]),
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    replicaSelect.mockReturnValue(query);

    await expect(
      supabaseGetScrapeByIdOnlyData("019e6f45-7778-727d-adf0-0abe9d5062b6"),
    ).resolves.toEqual({ team_id: "legacy-team" });
  });

  it("does not fall back when a Bigtable row is expired", async () => {
    readApiJobAccess.mockResolvedValue({
      teamId: "team-id",
      kind: "scrape",
      expiresAtMs: Date.now() - 1,
    });

    await expect(
      supabaseGetScrapeByIdOnlyData("019e6f45-7778-727d-adf0-0abe9d5062b6"),
    ).resolves.toBeNull();
    expect(replicaSelect).not.toHaveBeenCalled();
  });
});
