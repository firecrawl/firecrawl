import { deriveDiff } from "../diff";
import { changeTrackingGetLastScrape } from "../../../../lib/change-tracking-store";
import { getJobFromGCS } from "../../../../lib/gcs-jobs";

vi.mock("../../../../lib/change-tracking-store", () => ({
  changeTrackingGetLastScrape: vi.fn(),
}));

vi.mock("../../../../lib/gcs-jobs", () => ({
  getJobFromGCS: vi.fn(),
}));

vi.mock("../llmExtract", () => ({
  generateCompletions: vi.fn(),
}));

describe("deriveDiff change tracking transformer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupPreviousScrape(previousMarkdown: string) {
    vi.mocked(changeTrackingGetLastScrape).mockResolvedValue({
      date_added: "2026-10-01T00:00:00.000Z",
      job_id: "mock-job-id",
    } as any);

    vi.mocked(getJobFromGCS).mockResolvedValue([
      {
        markdown: previousMarkdown,
      } as any,
    ]);
  }

  function createMeta(modes: string[] = ["git-diff"]): any {
    return {
      id: "mock-scrape-id",
      url: "https://example.com/product",
      options: {
        formats: [
          {
            type: "changeTracking",
            modes,
          },
        ],
      },
      internalOptions: {
        teamId: "mock-team-id",
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
      },
    };
  }

  it("detects changes when characters are reordered (e.g. price change $12 -> $21, issue #4941)", async () => {
    setupPreviousScrape("Price: $12");

    const meta = createMeta(["git-diff"]);
    const doc: any = {
      markdown: "Price: $21",
      metadata: {
        sourceURL: "https://example.com/product",
      },
    };

    const result = await deriveDiff(meta, doc);

    expect(result.changeTracking?.changeStatus).toBe("changed");
    expect(result.changeTracking?.diff?.text).toContain("-Price: $12");
    expect(result.changeTracking?.diff?.text).toContain("+Price: $21");
  });

  it("detects changes when word order is swapped without changing character frequencies", async () => {
    setupPreviousScrape("cat dog");

    const meta = createMeta(["git-diff"]);
    const doc: any = {
      markdown: "dog cat",
      metadata: {
        sourceURL: "https://example.com/product",
      },
    };

    const result = await deriveDiff(meta, doc);

    expect(result.changeTracking?.changeStatus).toBe("changed");
    expect(result.changeTracking?.diff?.text).toBeDefined();
  });

  it("reports 'same' when content is identical", async () => {
    setupPreviousScrape("Price: $12");

    const meta = createMeta(["git-diff"]);
    const doc: any = {
      markdown: "Price: $12",
      metadata: {
        sourceURL: "https://example.com/product",
      },
    };

    const result = await deriveDiff(meta, doc);

    expect(result.changeTracking?.changeStatus).toBe("same");
    expect(result.changeTracking?.diff).toBeUndefined();
  });

  it("reports 'same' when only whitespace differs", async () => {
    setupPreviousScrape("Price:   $12\n\nIn stock.");

    const meta = createMeta(["git-diff"]);
    const doc: any = {
      markdown: "Price: $12 In stock.",
      metadata: {
        sourceURL: "https://example.com/product",
      },
    };

    const result = await deriveDiff(meta, doc);

    expect(result.changeTracking?.changeStatus).toBe("same");
    expect(result.changeTracking?.diff).toBeUndefined();
  });

  it("reports 'same' when only iframe URLs differ", async () => {
    setupPreviousScrape("Check this out: [iframe](https://example.com/embed1)");

    const meta = createMeta(["git-diff"]);
    const doc: any = {
      markdown: "Check this out: [iframe](https://example.com/embed2)",
      metadata: {
        sourceURL: "https://example.com/product",
      },
    };

    const result = await deriveDiff(meta, doc);

    expect(result.changeTracking?.changeStatus).toBe("same");
    expect(result.changeTracking?.diff).toBeUndefined();
  });
});
