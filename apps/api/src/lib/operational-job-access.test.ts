const {
  readApiJobAccess,
  supabaseGetAgentRequestByIdDirect,
  supabaseGetCrawlRequestById,
  supabaseGetExtractRequestByIdDirect,
  supabaseGetScrapeById,
} = vi.hoisted(() => ({
  readApiJobAccess: vi.fn(),
  supabaseGetAgentRequestByIdDirect: vi.fn(),
  supabaseGetCrawlRequestById: vi.fn(),
  supabaseGetExtractRequestByIdDirect: vi.fn(),
  supabaseGetScrapeById: vi.fn(),
}));

vi.mock("./job-access-store", () => ({ readApiJobAccess }));
vi.mock("./supabase-jobs", () => ({
  supabaseGetAgentRequestByIdDirect,
  supabaseGetCrawlRequestById,
  supabaseGetExtractRequestByIdDirect,
  supabaseGetScrapeById,
}));

import {
  getAgentJobAccess,
  getExtractJobAccess,
  getScrapeJobAccess,
} from "./operational-job-access";

const JOB_ID = "019e6f45-7778-727d-adf0-0abe9d5062b6";

describe("operational job access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the typed Bigtable record without querying PostgreSQL", async () => {
    const access = {
      teamId: "team-id",
      kind: "agent",
      clientOrigin: "python-sdk@4.37.1",
      expiresAtMs: Date.now() + 60_000,
    };
    readApiJobAccess.mockResolvedValue(access);

    await expect(getAgentJobAccess(JOB_ID)).resolves.toBe(access);
    expect(supabaseGetAgentRequestByIdDirect).not.toHaveBeenCalled();
  });

  it("maps a PostgreSQL fallback into the operational access type", async () => {
    readApiJobAccess.mockResolvedValue(null);
    supabaseGetExtractRequestByIdDirect.mockResolvedValue({
      id: JOB_ID,
      team_id: "team-id",
      kind: "extract",
      origin: "api",
      created_at: "2026-09-16T12:00:00.000Z",
      unrelated_column: "not returned",
    });

    await expect(getExtractJobAccess(JOB_ID)).resolves.toEqual({
      teamId: "team-id",
      kind: "extract",
      clientOrigin: "api",
      expiresAtMs: new Date("2026-09-17T12:00:00.000Z").getTime(),
    });
  });

  it("does not fall back when Bigtable has an expired record", async () => {
    const access = {
      teamId: "team-id",
      kind: "scrape",
      expiresAtMs: Date.now() - 1,
    };
    readApiJobAccess.mockResolvedValue(access);

    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBe(access);
    expect(supabaseGetScrapeById).not.toHaveBeenCalled();
  });

  it("does not fall back when Bigtable has a different job kind", async () => {
    readApiJobAccess.mockResolvedValue({
      teamId: "team-id",
      kind: "crawl",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBeNull();
    expect(supabaseGetScrapeById).not.toHaveBeenCalled();
  });
});
