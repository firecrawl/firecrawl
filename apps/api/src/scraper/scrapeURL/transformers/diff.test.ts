import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDiff } from "./diff";
import { Meta } from "../index";
import { Document } from "../../../controllers/v1/types";

const mocks = vi.hoisted(() => ({
  changeTrackingGetLastScrape: vi.fn(),
  getJobFromGCS: vi.fn(),
  generateCompletions: vi.fn(),
}));

vi.mock("../../../lib/change-tracking-store", () => ({
  changeTrackingGetLastScrape: mocks.changeTrackingGetLastScrape,
}));

vi.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: mocks.getJobFromGCS,
}));

vi.mock("./llmExtract", () => ({
  generateCompletions: mocks.generateCompletions,
}));

describe("deriveDiff change tracking order preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMeta = (formats = [{ type: "changeTracking", modes: ["git-diff"] }]): Meta =>
    ({
      id: "scrape-test-id",
      url: "https://example.com/products/item-1",
      options: { formats },
      internalOptions: {
        teamId: "team-test-id",
      },
      logger: {
        child: () => ({ error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
        debug: vi.fn(),
        error: vi.fn(),
      },
    }) as unknown as Meta;

  const mockPreviousJob = (previousMarkdown: string) => {
    mocks.changeTrackingGetLastScrape.mockResolvedValue({
      job_id: "prev-job-123",
      date_added: "2026-10-15T00:00:00.000Z",
    });
    mocks.getJobFromGCS.mockResolvedValue([
      {
        markdown: previousMarkdown,
        metadata: { statusCode: 200, sourceURL: "https://example.com/products/item-1" },
      },
    ]);
  };

  it("detects price transposition as changed instead of same", async () => {
    mockPreviousJob("Price: $12");

    const currentDoc: Document = {
      markdown: "Price: $21",
      metadata: {
        statusCode: 200,
        sourceURL: "https://example.com/products/item-1",
      },
    };

    const result = await deriveDiff(createMeta(), currentDoc);

    expect(result.changeTracking?.changeStatus).toBe("changed");
    expect(result.changeTracking?.diff).toBeDefined();
    expect(result.changeTracking?.diff?.text).toContain("-Price: $12");
    expect(result.changeTracking?.diff?.text).toContain("+Price: $21");
  });

  it("detects character order swaps in text instructions", async () => {
    mockPreviousJob("Step 12: then Step 21");

    const currentDoc: Document = {
      markdown: "Step 21: then Step 12",
      metadata: {
        statusCode: 200,
        sourceURL: "https://example.com/products/item-1",
      },
    };

    const result = await deriveDiff(createMeta(), currentDoc);

    expect(result.changeTracking?.changeStatus).toBe("changed");
  });

  it("detects word order rearrangement as changed", async () => {
    mockPreviousJob("feature is not active");

    const currentDoc: Document = {
      markdown: "feature is active not",
      metadata: {
        statusCode: 200,
        sourceURL: "https://example.com/products/item-1",
      },
    };

    const result = await deriveDiff(createMeta(), currentDoc);

    expect(result.changeTracking?.changeStatus).toBe("changed");
  });

  it("considers documents with only whitespace differences as same", async () => {
    mockPreviousJob("Price: $12\n\nStock: 5");

    const currentDoc: Document = {
      markdown: "Price:    $12   Stock:  5",
      metadata: {
        statusCode: 200,
        sourceURL: "https://example.com/products/item-1",
      },
    };

    const result = await deriveDiff(createMeta(), currentDoc);

    expect(result.changeTracking?.changeStatus).toBe("same");
  });

  it("ignores iframe URL differences and treats content without other changes as same", async () => {
    mockPreviousJob("Welcome [iframe](https://ads.com/1) to our site");

    const currentDoc: Document = {
      markdown: "Welcome [iframe](https://ads.com/2) to our site",
      metadata: {
        statusCode: 200,
        sourceURL: "https://example.com/products/item-1",
      },
    };

    const result = await deriveDiff(createMeta(), currentDoc);

    expect(result.changeTracking?.changeStatus).toBe("same");
  });
});
