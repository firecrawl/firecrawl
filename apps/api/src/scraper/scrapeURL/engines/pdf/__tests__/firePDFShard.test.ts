import { describe, expect, it, vi } from "vitest";
import { config } from "../../../../../config";
import type { Meta } from "../../..";
import {
  computeShardRanges,
  mergeShardResults,
  runShardedFirePdfAttempt,
  type ShardResult,
} from "../fire-pdf/shard";
import type { PDFProcessorResult } from "../types";

describe("computeShardRanges", () => {
  it("splits into disjoint half-open ranges covering the document", () => {
    expect(computeShardRanges(3000, 1000)).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
    ]);
  });

  it("keeps a small remainder as its own shard — never a 1.5x-sized job", () => {
    // The shard size bounds per-job runtime against the timeout/lease
    // envelope; merging a tail into its neighbor would break that bound.
    expect(computeShardRanges(3200, 1000)).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
      [3000, 3200],
    ]);
  });

  it("never emits a range longer than shardPages", () => {
    for (const total of [999, 1000, 1001, 2500, 6543]) {
      for (const [start, end] of computeShardRanges(total, 1000)) {
        expect(end - start).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("covers exactly, no overlaps, for awkward sizes", () => {
    const ranges = computeShardRanges(6543, 1000);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(6543);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    }
  });
});

function shard(
  range: [number, number],
  result: Partial<PDFProcessorResult>,
): ShardResult {
  return { range, result: { html: "", ...result } as PDFProcessorResult };
}

describe("mergeShardResults", () => {
  it("concatenates markdown in page order with the page-break separator", () => {
    const merged = mergeShardResults(
      [
        shard([1000, 2000], { markdown: "second", pagesProcessed: 1000 }),
        shard([0, 1000], { markdown: "first", pagesProcessed: 1000 }),
      ],
      false,
    );
    expect(merged.markdown).toBe("first\n\n---\n\nsecond");
    expect(merged.pagesProcessed).toBe(2000);
  });

  it("labels shard boundaries with the next shard's first page when markers are on", () => {
    const merged = mergeShardResults(
      [
        shard([0, 1000], { markdown: "first" }),
        shard([1000, 2000], { markdown: "second" }),
      ],
      true,
    );
    expect(merged.markdown).toBe(
      "first\n\n---\n\n<!-- page 1001 -->\n\nsecond",
    );
  });

  it("drops empty overshoot shards (range past the document's real end)", () => {
    const merged = mergeShardResults(
      [
        shard([0, 1000], { markdown: "only", pagesProcessed: 900 }),
        shard([1000, 2000], { markdown: "", pagesProcessed: 0 }),
      ],
      true,
    );
    expect(merged.markdown).toBe("only");
    expect(merged.pagesProcessed).toBe(900);
  });

  it("shifts blocks' markdown_span by each shard's offset in the merged doc", () => {
    const item = (span: [number, number] | null) => ({
      id: "b",
      type: "text",
      label: null,
      bbox: null,
      content: "x",
      markdown_span: span,
      reading_order: 0,
      source: null,
      confidence: { layout: null, ocr: null },
    });
    const merged = mergeShardResults(
      [
        shard([0, 1000], {
          markdown: "first",
          blocks: [
            {
              page: 1,
              width: 1,
              height: 1,
              status: "ok",
              items: [item([0, 5])],
            },
          ],
        }),
        shard([1000, 2000], {
          markdown: "second",
          blocks: [
            {
              page: 1001,
              width: 1,
              height: 1,
              status: "ok",
              items: [item([0, 6]), item(null)],
            },
          ],
        }),
      ],
      false,
    );
    // "first" + "\n\n---\n\n" = second shard's markdown starts at 12.
    const [b1, b2] = merged.blocks ?? [];
    expect(b1.items[0].markdown_span).toEqual([0, 5]);
    expect(b2.items[0].markdown_span).toEqual([12, 18]);
    expect(b2.items[1].markdown_span).toBeNull();
    expect(merged.markdown.slice(12, 18)).toBe("second");
  });

  it("concatenates per-page markdown across shards", () => {
    const merged = mergeShardResults(
      [
        shard([0, 2], {
          markdown: "a",
          pageMarkdown: [
            { page: 1, markdown: "p1" },
            { page: 2, markdown: "p2" },
          ],
        }),
        shard([2, 4], {
          markdown: "b",
          pageMarkdown: [{ page: 3, markdown: "p3" }],
        }),
      ],
      false,
    );
    expect(merged.pageMarkdown?.map(p => p.page)).toEqual([1, 2, 3]);
  });
});

describe("runShardedFirePdfAttempt", () => {
  function makeMeta(): Meta {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => logger),
    };
    return {
      id: "fc_parent",
      logger,
      abort: { throwIfAborted: vi.fn() },
      internalOptions: {},
      largePdfProcessing: {},
    } as unknown as Meta;
  }

  const baseArgs = {
    placeInput: async () => ({
      gcsUri: "gs://b/inputs/x.pdf",
      sha256: "a".repeat(64),
      sizeBytes: 1000,
    }),
    effectivePages: 2600,
    mode: undefined,
    includePageMarkdown: false,
    includeBlocks: false,
    pageMarkers: false,
    localSha256: undefined,
    cacheable: false,
  } as const;

  it("runs every shard, merges in order, and records whole-doc processing state", async () => {
    const meta = makeMeta();
    const calls: Array<[number, number]> = [];
    const runShardImpl = async (
      _args: unknown,
      _getUploaded: unknown,
      range: [number, number],
      _shardIndex: number,
      _container: unknown,
    ): Promise<PDFProcessorResult> => {
      calls.push(range);
      return {
        html: "",
        markdown: `pages-${range[0]}-${range[1]}`,
        pagesProcessed: range[1] - range[0],
      } as PDFProcessorResult;
    };
    const result = await runShardedFirePdfAttempt({
      ...baseArgs,
      meta,
      runShardImpl,
    });
    // Derive from config so env overrides don't break the assertion.
    const expectedRanges = computeShardRanges(2600, config.PDF_SHARD_PAGES);
    expect(calls).toEqual(expectedRanges);
    expect(result.markdown).toBe(
      expectedRanges.map(r => `pages-${r[0]}-${r[1]}`).join("\n\n---\n\n"),
    );
    expect(result.pagesProcessed).toBe(2600);
    // Every shard is terminal — nothing "continues" past this point, so
    // the processing state must be cleared (a later local failure must
    // not produce a processing_continues message for finished work).
    expect(meta.largePdfProcessing?.current).toBeUndefined();
  });

  it("fails the whole attempt when a shard hard-fails", async () => {
    const meta = makeMeta();
    const runShardImpl = async (
      _args: unknown,
      _getUploaded: unknown,
      range: [number, number],
      _shardIndex: number,
      container: unknown,
    ): Promise<PDFProcessorResult> => {
      if (range[0] === 1000) throw new Error("shard exploded");
      // Successful shards mark themselves accepted, as the async runner
      // does on submit-accept.
      (container as { current?: object }).current = { lastStatus: "running" };
      return { html: "", markdown: "ok" } as PDFProcessorResult;
    };
    await expect(
      runShardedFirePdfAttempt({ ...baseArgs, meta, runShardImpl }),
    ).rejects.toThrow("shard exploded");
    // Sibling shards exist and keep running server-side after one shard
    // fails, so "processing continues" stays true for the document.
    expect(meta.largePdfProcessing?.current?.pagesEstimate).toBe(2600);
  });

  it("clears processing state when no shard ever materialized server-side", async () => {
    const meta = makeMeta();
    const runShardImpl = async (): Promise<PDFProcessorResult> => {
      // Aborted/failed before any submit was accepted — no container
      // write, mirroring the async runner's behavior.
      throw new Error("aborted before submit");
    };
    await expect(
      runShardedFirePdfAttempt({ ...baseArgs, meta, runShardImpl }),
    ).rejects.toThrow("aborted before submit");
    // A timeout must not tell the caller that processing continues for
    // a job that never existed.
    expect(meta.largePdfProcessing?.current).toBeUndefined();
  });

  it("stops launching queued shards once one fails", async () => {
    const meta = makeMeta();
    const launched: number[] = [];
    const runShardImpl = async (
      _args: unknown,
      _getUploaded: unknown,
      range: [number, number],
      _shardIndex: number,
      _container: unknown,
    ): Promise<PDFProcessorResult> => {
      launched.push(range[0]);
      throw new Error("first shard fails");
    };
    await expect(
      runShardedFirePdfAttempt({
        ...baseArgs,
        effectivePages: 10_000, // 10 shards, concurrency 4
        meta,
        runShardImpl,
      }),
    ).rejects.toThrow("first shard fails");
    // Only the first concurrency wave may have launched — never the
    // remaining queued shards (submitting more work for a doomed
    // attempt only burns GPU).
    expect(launched.length).toBeLessThanOrEqual(config.PDF_SHARD_CONCURRENCY);
    expect(launched.length).toBeLessThan(
      computeShardRanges(10_000, config.PDF_SHARD_PAGES).length,
    );
  });
});
