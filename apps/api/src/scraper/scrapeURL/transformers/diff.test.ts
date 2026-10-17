import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Meta } from "../index";
import type { Document } from "../../../controllers/v1/types";
import { changeTrackingGetLastScrape } from "../../../lib/change-tracking-store";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import { generateCompletions } from "./llmExtract";
import { deriveDiff } from "./diff";

vi.mock("../../../lib/change-tracking-store", () => ({
  changeTrackingGetLastScrape: vi.fn(),
}));
vi.mock("../../../lib/gcs-jobs", () => ({ getJobFromGCS: vi.fn() }));
vi.mock("./llmExtract", () => ({ generateCompletions: vi.fn() }));

const sourceURL = "https://example.com/prices";
const previousScrapeAt = "2026-01-01T00:00:00.000Z";

function makeMeta(modes: ("git-diff" | "json")[] = ["git-diff"]): Meta {
  const logger = { debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return {
    id: "current-scrape",
    url: sourceURL,
    options: { formats: [{ type: "changeTracking", modes }] },
    internalOptions: { teamId: "test-team" },
    logger,
  } as unknown as Meta;
}

function makeDocument(markdown: string, statusCode = 200): Document {
  return { markdown, metadata: { sourceURL, statusCode, proxyUsed: "basic" } };
}

function setPreviousMarkdown(markdown: string) {
  vi.mocked(getJobFromGCS).mockResolvedValue([makeDocument(markdown)]);
}

describe("change tracking content comparison", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(changeTrackingGetLastScrape).mockResolvedValue({
      job_id: "previous-scrape",
      date_added: previousScrapeAt,
    });
    setPreviousMarkdown("Price: $12");
  });

  it.each([
    ["Price: $12", "Price: $21"],
    ["Basic: $10\nPro: $20", "Basic: $20\nPro: $10"],
    ["Available: yes\nDiscontinued: no", "Available: no\nDiscontinued: yes"],
    ["1. Build\n2. Deploy", "1. Deploy\n2. Build"],
  ])("detects reordered content: %s -> %s", async (previous, current) => {
    setPreviousMarkdown(previous);

    const result = await deriveDiff(makeMeta(), makeDocument(current));

    expect(result.changeTracking).toMatchObject({
      changeStatus: "changed",
      previousScrapeAt,
      visibility: "visible",
    });
    // Exercise the real unified/structured diff generation, not a mocked diff.
    const changes = result.changeTracking!.diff!.json.files.flatMap(file =>
      file.chunks.flatMap(chunk => chunk.changes),
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "del",
          content: `-${previous.split("\n")[0]}`,
        }),
        expect.objectContaining({
          type: "add",
          content: `+${current.split("\n")[0]}`,
        }),
      ]),
    );
    expect(result.changeTracking!.diff!.text).toContain(
      `+${current.split("\n")[0]}`,
    );
  });

  it("runs structured comparison when a price's digits change order", async () => {
    vi.mocked(generateCompletions).mockResolvedValue({
      extract: { price: { previous: 12, current: 21 } },
    } as Awaited<ReturnType<typeof generateCompletions>>);

    const result = await deriveDiff(
      makeMeta(["json"]),
      makeDocument("Price: $21"),
    );

    expect(result.changeTracking?.changeStatus).toBe("changed");
    expect(generateCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown:
          "Previous Content:\nPrice: $12\n\nCurrent Content:\nPrice: $21",
      }),
    );
    expect(result.changeTracking?.json).toEqual({
      price: { previous: 12, current: 21 },
    });
  });

  it.each([
    ["Price: $12", "Price: $12"],
    ["Price: $12", "Price:  $12\n"],
    [
      "Price: $12\n[iframe](https://example.com/old)",
      "Price: $12\n[iframe](https://example.com/new)",
    ],
  ])(
    "preserves existing normalization for unchanged content",
    async (previous, current) => {
      setPreviousMarkdown(previous);
      const result = await deriveDiff(
        makeMeta(["git-diff", "json"]),
        makeDocument(current),
      );
      expect(result.changeTracking?.changeStatus).toBe("same");
      expect(result.changeTracking?.diff).toBeUndefined();
      expect(generateCompletions).not.toHaveBeenCalled();
    },
  );

  it("keeps 404 responses removed even when content changes", async () => {
    const result = await deriveDiff(
      makeMeta(),
      makeDocument("Price: $21", 404),
    );
    expect(result.changeTracking?.changeStatus).toBe("removed");
    expect(result.changeTracking?.diff).toBeUndefined();
  });

  it("marks a scrape without history new", async () => {
    vi.mocked(changeTrackingGetLastScrape).mockResolvedValue(null);
    const result = await deriveDiff(makeMeta(), makeDocument("Price: $21"));
    expect(result.changeTracking).toMatchObject({
      changeStatus: "new",
      previousScrapeAt: null,
    });
    expect(getJobFromGCS).not.toHaveBeenCalled();
  });

  it("preserves the warning when the history store is unavailable", async () => {
    vi.mocked(changeTrackingGetLastScrape).mockRejectedValue(
      new Error("store unavailable"),
    );
    const result = await deriveDiff(makeMeta(), makeDocument("Price: $21"));
    expect(result.changeTracking).toBeUndefined();
    expect(result.warning).toContain("Comparing failed");
  });

  it("preserves structured comparison failure warnings", async () => {
    vi.mocked(generateCompletions).mockRejectedValue(
      new Error("provider unavailable"),
    );
    const result = await deriveDiff(
      makeMeta(["json"]),
      makeDocument("Price: $21"),
    );
    expect(result.changeTracking?.changeStatus).toBe("changed");
    expect(result.warning).toContain("Structured diff generation failed");
  });
});
