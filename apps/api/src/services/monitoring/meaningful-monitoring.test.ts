// vi.mock is hoisted above declarations, so the mocks its factories reference
// are created in vi.hoisted() (also hoisted) to avoid any TDZ surprises.
const { mockJudge, mockSave, mockGetJob } = vi.hoisted(() => ({
  mockJudge: vi.fn(),
  mockSave: vi.fn(async (..._args: any[]) => ({ textBytes: 1, jsonBytes: 1 })),
  mockGetJob: vi.fn(),
}));

vi.mock("uuid", () => ({ v7: () => "test-uuid" }));
vi.mock("./judgeChange", () => ({
  judgeChange: (args: any) => mockJudge(args),
}));
vi.mock("../../lib/gcs-jobs", () => ({
  getJobFromGCS: (id: any) => mockGetJob(id),
}));
vi.mock("../../lib/gcs-monitoring", () => ({
  saveMonitorDiffArtifact: (key: any, artifact: any) => mockSave(key, artifact),
  monitorDiffGcsKey: () => "fake-gcs-key",
}));

import { computeAndPersistPageDiff } from "./diff-orchestrator";
import { derivePageIsMeaningful } from "./page-events";

const FAKE_JUDGMENT = {
  meaningful: true as const,
  confidence: "high" as const,
  reason: "test",
  meaningfulChanges: [
    {
      type: "changed" as const,
      before: "old test",
      after: "new test",
      reason: "The tracked value changed.",
    },
  ],
};

const FRESH_PAGE = {
  teamId: "team-1",
  monitorId: "monitor-1",
  checkId: "check-1",
  url: "https://example.com",
  scrapeId: "scrape-2",
};

beforeEach(() => {
  mockJudge.mockReset();
  mockSave.mockClear();
  mockGetJob.mockReset();
});

describe("computeAndPersistPageDiff — judge gating", () => {
  it("skips judge when previous is null", async () => {
    const result = await computeAndPersistPageDiff({
      ...FRESH_PAGE,
      doc: { markdown: "hello world" },
      previous: null,
      formats: ["markdown"],
      goal: "track anything",
    });
    expect(result.status).toBe("new");
    expect(result.judgment).toBeUndefined();
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("skips judge when goal is null", async () => {
    mockGetJob.mockResolvedValue([{ markdown: "previous content here" }]);
    const result = await computeAndPersistPageDiff({
      ...FRESH_PAGE,
      doc: { markdown: "current content here — totally different" },
      previous: { last_scrape_id: "scrape-1", is_removed: false },
      formats: ["markdown"],
      goal: null,
    });
    expect(result.status).toBe("changed");
    expect(result.judgment).toBeUndefined();
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("skips judge when content is unchanged", async () => {
    const identical = "identical text";
    mockGetJob.mockResolvedValue([{ markdown: identical }]);
    const result = await computeAndPersistPageDiff({
      ...FRESH_PAGE,
      doc: { markdown: identical },
      previous: { last_scrape_id: "scrape-1", is_removed: false },
      formats: ["markdown"],
      goal: "track anything",
    });
    expect(result.status).toBe("same");
    expect(result.judgment).toBeUndefined();
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("calls judge with markdown diff when goal is set and page changed", async () => {
    mockGetJob.mockResolvedValue([{ markdown: "old content" }]);
    mockJudge.mockResolvedValue(FAKE_JUDGMENT);
    const result = await computeAndPersistPageDiff({
      ...FRESH_PAGE,
      doc: { markdown: "new content totally different" },
      previous: { last_scrape_id: "scrape-1", is_removed: false },
      formats: ["markdown"],
      goal: "tell me when the content changes",
      extractionPrompt: "extract the heading",
    });
    expect(result.judgment).toEqual(FAKE_JUDGMENT);
    const callArgs = mockJudge.mock.calls[0][0];
    expect(callArgs.goal).toBe("tell me when the content changes");
    expect(callArgs.extractionPrompt).toBe("extract the heading");
    expect(callArgs.markdownDiff.diffText).toContain("-old content");
    expect(callArgs.markdownDiff.diffText).toContain(
      "+new content totally different",
    );
    expect(callArgs.markdownDiff.previous).toBeUndefined();
    expect(callArgs.markdownDiff.current).toBeUndefined();
  });

  it("returns no judgment if judge throws", async () => {
    mockGetJob.mockResolvedValue([{ markdown: "old content" }]);
    mockJudge.mockRejectedValue(new Error("gemini down"));
    const result = await computeAndPersistPageDiff({
      ...FRESH_PAGE,
      doc: { markdown: "new content" },
      previous: { last_scrape_id: "scrape-1", is_removed: false },
      formats: ["markdown"],
      goal: "track anything",
    });
    expect(result.status).toBe("changed");
    expect(result.judgment).toBeUndefined();
  });
});

describe("derivePageIsMeaningful", () => {
  it("returns the judge verdict only for changed pages; null otherwise", () => {
    expect(derivePageIsMeaningful("changed", { meaningful: true })).toBe(true);
    expect(derivePageIsMeaningful("changed", { meaningful: false })).toBe(
      false,
    );
    expect(derivePageIsMeaningful("changed", null)).toBeNull();
    for (const status of ["new", "same", "removed", "error"]) {
      expect(derivePageIsMeaningful(status, { meaningful: true })).toBeNull();
    }
  });
});
