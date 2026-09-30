const {
  readApiJobAccess,
  recordJobStorePostgresFallback,
  supabaseGetAgentRequestByIdDirect,
  supabaseGetCrawlRequestById,
  supabaseGetExtractRequestByIdDirect,
  supabaseGetScrapeById,
} = vi.hoisted(() => ({
  readApiJobAccess: vi.fn(),
  recordJobStorePostgresFallback: vi.fn(),
  supabaseGetAgentRequestByIdDirect: vi.fn(),
  supabaseGetCrawlRequestById: vi.fn(),
  supabaseGetExtractRequestByIdDirect: vi.fn(),
  supabaseGetScrapeById: vi.fn(),
}));

vi.mock("./job-access-store", () => ({ readApiJobAccess }));
vi.mock("./job-store-fallback", () => ({ recordJobStorePostgresFallback }));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
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

  it("maps a live PostgreSQL fallback into the operational access type and counts it", async () => {
    const createdAt = new Date(Date.now() - 60_000);
    readApiJobAccess.mockResolvedValue(null);
    supabaseGetExtractRequestByIdDirect.mockResolvedValue({
      id: JOB_ID,
      team_id: "team-id",
      kind: "extract",
      origin: "api",
      created_at: createdAt.toISOString(),
      unrelated_column: "not returned",
    });

    await expect(getExtractJobAccess(JOB_ID)).resolves.toEqual({
      teamId: "team-id",
      kind: "extract",
      clientOrigin: "api",
      expiresAtMs: createdAt.getTime() + 24 * 60 * 60 * 1000,
    });
    expect(recordJobStorePostgresFallback).toHaveBeenCalledWith(
      "job_access",
      JOB_ID,
      { kind: "extract" },
    );
  });

  it("does not count an expired PostgreSQL fallback (the caller 404s either way)", async () => {
    readApiJobAccess.mockResolvedValue(null);
    supabaseGetScrapeById.mockResolvedValue({
      id: JOB_ID,
      team_id: "team-id",
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    const access = await getScrapeJobAccess(JOB_ID);
    expect(access?.expiresAtMs).toBeLessThan(Date.now());
    expect(recordJobStorePostgresFallback).not.toHaveBeenCalled();
  });

  it("does not count a fallback taken because the Bigtable read failed", async () => {
    readApiJobAccess.mockRejectedValue(new Error("Bigtable unavailable"));
    supabaseGetScrapeById.mockResolvedValue({
      id: JOB_ID,
      team_id: "team-id",
      created_at: new Date().toISOString(),
    });

    await expect(getScrapeJobAccess(JOB_ID)).resolves.toMatchObject({
      teamId: "team-id",
      kind: "scrape",
    });
    expect(recordJobStorePostgresFallback).not.toHaveBeenCalled();
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
