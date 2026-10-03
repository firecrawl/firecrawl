const { readApiJobAccess } = vi.hoisted(() => ({
  readApiJobAccess: vi.fn(),
}));

vi.mock("./job-access-store", () => ({ readApiJobAccess }));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  getAgentJobAccess,
  getCrawlJobAccess,
  getExtractJobAccess,
  getScrapeJobAccess,
} from "./operational-job-access";

const JOB_ID = "019e6f45-7778-727d-adf0-0abe9d5062b6";

describe("operational job access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the typed Bigtable record", async () => {
    const access = {
      teamId: "team-id",
      kind: "agent",
      clientOrigin: "python-sdk@4.37.1",
      expiresAtMs: Date.now() + 60_000,
    };
    readApiJobAccess.mockResolvedValue(access);

    await expect(getAgentJobAccess(JOB_ID)).resolves.toBe(access);
  });

  it("extract access accepts extract and agent records and rejects a scrape", async () => {
    const base = { teamId: "team-id", expiresAtMs: Date.now() + 60_000 };
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "extract" });
    await expect(getExtractJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "extract",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "agent" });
    await expect(getExtractJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "agent",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "scrape" });
    await expect(getExtractJobAccess(JOB_ID)).resolves.toBeNull();
  });

  it("returns an expired record so the caller can answer 404 with its expiry", async () => {
    const access = {
      teamId: "team-id",
      kind: "scrape",
      expiresAtMs: Date.now() - 1,
    };
    readApiJobAccess.mockResolvedValue(access);

    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBe(access);
  });

  it("returns null for a different job kind", async () => {
    readApiJobAccess.mockResolvedValue({
      teamId: "team-id",
      kind: "crawl",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBeNull();
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "crawl",
    });
  });

  it("crawl access accepts crawl and batch_scrape records and rejects a scrape", async () => {
    const base = { teamId: "team-id", expiresAtMs: Date.now() + 60_000 };
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "crawl" });
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "crawl",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "batch_scrape" });
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "batch_scrape",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "scrape" });
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toBeNull();
  });

  it("returns null when Bigtable has no row", async () => {
    readApiJobAccess.mockResolvedValue(null);
    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBeNull();
  });

  it("answers not found for an id that is not a UUIDv7, without reading", async () => {
    await expect(
      getScrapeJobAccess("817f931c-89b5-472d-977c-b7061ac3ce1c"),
    ).resolves.toBeNull();
    await expect(getCrawlJobAccess("not-a-uuid")).resolves.toBeNull();
    expect(readApiJobAccess).not.toHaveBeenCalled();
  });

  it("rethrows a failed Bigtable read instead of reporting a missing job", async () => {
    readApiJobAccess.mockRejectedValue(new Error("Bigtable unavailable"));
    await expect(getScrapeJobAccess(JOB_ID)).rejects.toThrow(
      "Bigtable unavailable",
    );
  });
});
