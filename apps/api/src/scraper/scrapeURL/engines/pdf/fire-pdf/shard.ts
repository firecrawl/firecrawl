/**
 * Sharded fire-pdf processing for monster documents.
 *
 * A document past PDF_SHARD_THRESHOLD_PAGES cannot finish as one job:
 * the async deadline cap, the RabbitMQ consumer window, and the lease
 * design point all sit near 30 minutes, and a multi-thousand-page scan
 * needs more. Instead of raising every ceiling for one document class,
 * the by-reference flow splits the document into page-range shard jobs
 * (fire-pdf `options.page_range`) that share one uploaded input and each
 * finish in ~10-15 minutes, then merges the results in page order.
 *
 * Shard identity is content-level: `page_range` is an idempotency option
 * on the fire-pdf side, so a retry of the whole scrape adopts every
 * in-flight shard (per-shard lookup below) and finished shards are
 * deduped server-side. The firecrawl-layer cache stores only the MERGED
 * whole-document result — shard-scoped calls are uncacheable at that
 * layer by construction (see cacheKeyShape).
 *
 * Fan-out is bounded by PDF_SHARD_CONCURRENCY: an unbounded burst of
 * shards floods the GPU fleet's standing headroom and trips the OCR
 * timeout-retry spiral (measured 2026-08-27, chunk-window experiments).
 */
import { config } from "../../../../../config";
import type { PDFMode } from "../../../../../controllers/v2/types";
import type { Meta } from "../../..";
import { safeMarkdownToHtml } from "../markdownToHtml";
import type { PDFProcessorResult } from "../types";
import { FirePdfAsyncFailure, scrapePDFWithFirePDFAsync } from "./async";
import type { FirePdfByReferenceInput } from "./by-reference";
import { maybeSaveResult } from "./cache";
import {
  type FirePdfAdoptedJobInput,
  lookupAdoptableFirePdfJob,
} from "./lookup";
import { buildFirePdfJobOptions } from "./utils";

/** Disjoint `[start, end)` ranges covering `[0, totalPages)`. Every
 * range is AT MOST `shardPages` long — a strict bound, because the
 * shard size exists to keep each job inside the per-job timeout/lease
 * envelope. A small tail stays its own (cheap) job rather than being
 * merged into a 1.5x-sized neighbor that could violate that envelope. */
export function computeShardRanges(
  totalPages: number,
  shardPages: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < totalPages; start += shardPages) {
    ranges.push([start, Math.min(start + shardPages, totalPages)]);
  }
  return ranges;
}

export type ShardResult = {
  range: [number, number];
  result: PDFProcessorResult;
};

/**
 * Concatenate shard results in page order. Shard outputs carry ABSOLUTE
 * page numbering (fire-pdf renumbers markers, pages[], blocks[], and
 * failure arrays by the range start), so the merge is ordered
 * concatenation plus two seam concerns:
 *
 *  - markdown: shards join with the same separator assembly emits
 *    between pages; with pageMarkers the boundary marker names the next
 *    shard's first page (assembly's markers announce the FOLLOWING
 *    page's content).
 *  - blocks[].items[].markdown_span: spans index into the SHARD's
 *    markdown, so each shard's spans shift by the offset where its
 *    markdown lands in the merged document.
 *
 * Shards that produced nothing (a range past the document's real end —
 * the caller's page estimate overshot) are dropped.
 */
export function mergeShardResults(
  shards: ShardResult[],
  pageMarkers: boolean,
): Omit<PDFProcessorResult, "html"> & { markdown: string } {
  const ordered = [...shards].sort((a, b) => a.range[0] - b.range[0]);
  const present = ordered.filter(
    s =>
      (s.result.markdown ?? "").length > 0 ||
      (s.result.pagesProcessed ?? 0) > 0,
  );

  let markdown = "";
  const pageMarkdown: NonNullable<PDFProcessorResult["pageMarkdown"]> = [];
  const blocks: NonNullable<PDFProcessorResult["blocks"]> = [];
  let pagesProcessed: number | undefined;
  let sawPageMarkdown = false;
  let sawBlocks = false;

  for (const [idx, shard] of present.entries()) {
    if (idx > 0) {
      markdown += "\n\n---\n\n";
      if (pageMarkers) {
        markdown += `<!-- page ${shard.range[0] + 1} -->\n\n`;
      }
    }
    const spanOffset = markdown.length;
    markdown += shard.result.markdown ?? "";

    if (shard.result.pageMarkdown) {
      sawPageMarkdown = true;
      pageMarkdown.push(...shard.result.pageMarkdown);
    }
    if (shard.result.blocks) {
      sawBlocks = true;
      blocks.push(
        ...shard.result.blocks.map(b => ({
          ...b,
          items:
            spanOffset === 0
              ? b.items
              : b.items.map(item =>
                  item.markdown_span === null
                    ? item
                    : {
                        ...item,
                        markdown_span: [
                          item.markdown_span[0] + spanOffset,
                          item.markdown_span[1] + spanOffset,
                        ] as [number, number],
                      },
                ),
        })),
      );
    }
    if (shard.result.pagesProcessed !== undefined) {
      pagesProcessed = (pagesProcessed ?? 0) + shard.result.pagesProcessed;
    }
  }

  return {
    markdown,
    ...(pagesProcessed !== undefined ? { pagesProcessed } : {}),
    ...(sawPageMarkdown ? { pageMarkdown } : {}),
    ...(sawBlocks ? { blocks } : {}),
  };
}

/** Input placement could not complete (rewrite AND upload failed). The
 * by-reference flow maps this to its pre-placement contract: fall
 * through to the legacy chain. */
export class ShardPlacementFailedError extends Error {
  constructor() {
    super("fire-pdf shard input placement failed");
    this.name = "ShardPlacementFailedError";
  }
}

type ShardedAttemptArgs = {
  meta: Meta;
  /** Lazy input placement (rewrite-or-upload). Called at most once, and
   * only when some shard needs a FRESH submit — a retry whose shards all
   * adopt prior work never re-uploads the input. */
  placeInput: () => Promise<FirePdfByReferenceInput | null>;
  /** Pages the document is believed to hold (the by-reference estimate). */
  effectivePages: number;
  mode: PDFMode | undefined;
  includePageMarkdown: boolean;
  includeBlocks: boolean;
  pageMarkers: boolean;
  localSha256: string | undefined;
  /** Whether the MERGED whole-document result may be cached (the
   * by-reference raw-sha cacheability the caller already computed). */
  cacheable: boolean;
  /** Test seam: replaces the per-shard adopt-or-submit runner. */
  runShardImpl?: typeof runOneShard;
};

export async function runShardedFirePdfAttempt(
  args: ShardedAttemptArgs,
): Promise<PDFProcessorResult> {
  const { meta } = args;
  const ranges = computeShardRanges(
    args.effectivePages,
    config.PDF_SHARD_PAGES,
  );
  const runShard = args.runShardImpl ?? runOneShard;
  meta.logger.info("FirePDF sharding large document", {
    method: "scrapePDF/firePdfSharded",
    scrape_id: meta.id,
    pages_estimate: args.effectivePages,
    shards: ranges.length,
    shard_pages: config.PDF_SHARD_PAGES,
    concurrency: config.PDF_SHARD_CONCURRENCY,
  });

  // Whole-document processing state for the timeout messaging: shard
  // sub-calls receive a meta WITHOUT the container (below), so their
  // per-shard writes never shrink the customer-facing page count. The
  // static page-scaled estimate over the full document carries the
  // `processing_continues` contract; shard jobs are by-reference, so
  // they keep running when this caller's window ends and a retry adopts
  // them per shard.
  // Written before the first shard submit on purpose: the alternative —
  // waiting for a shard to confirm submission — delays timeout
  // enrichment by minutes. The exposure is the seconds-wide window
  // between here and the first submit; an abort in that window
  // over-claims "processing continues", which a retry resolves with one
  // fresh submit. Status stays LIVE: each shard call gets its own
  // container (below), and the whole-document view derives its status
  // from them via a getter, so a mid-run timeout reports "running" as
  // soon as any shard does — while shard-local page counts never
  // overwrite the whole-document estimate.
  const shardContainers: NonNullable<Meta["largePdfProcessing"]>[] = ranges.map(
    () => ({}),
  );
  if (meta.largePdfProcessing) {
    meta.largePdfProcessing.current = {
      jobScrapeId: `${meta.id}_s0`,
      pagesEstimate: args.effectivePages,
      submittedAtMs: Date.now(),
      get lastStatus() {
        return shardContainers.some(c => c.current?.lastStatus === "running")
          ? ("running" as const)
          : ("queued" as const);
      },
    };
  }

  // Memoized lazy placement shared by every shard needing a fresh submit.
  let placement: Promise<FirePdfByReferenceInput | null> | undefined;
  let placedSha256: string | undefined;
  const getUploaded = async (): Promise<FirePdfByReferenceInput> => {
    placement ??= args.placeInput();
    const uploaded = await placement;
    if (!uploaded) throw new ShardPlacementFailedError();
    // Upload hashes in-pipeline, so a failed local pre-hash
    // (localSha256 undefined) still yields a usable identity for the
    // merged-result cache save below.
    placedSha256 = uploaded.sha256;
    return uploaded;
  };

  const results: PDFProcessorResult[] = new Array(ranges.length);
  let nextIndex = 0;
  // One shard failing fails the attempt — stop LAUNCHING queued shards
  // immediately (submitting more work for a doomed attempt only burns
  // GPU); shards already in flight run to completion server-side and
  // feed the retry's adoption.
  let failed = false;
  const workerCount = Math.min(config.PDF_SHARD_CONCURRENCY, ranges.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const i = nextIndex++;
      if (i >= ranges.length) return;
      meta.abort.throwIfAborted();
      try {
        results[i] = await runShard(
          args,
          getUploaded,
          ranges[i],
          i,
          shardContainers[i],
        );
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  // First hard shard failure fails the attempt (all-or-nothing: a
  // partial monster is a silent-quality trap). In-flight siblings are
  // left to finish server-side BY DESIGN — they are by-reference jobs,
  // so the work lands in adoption/cache and the customer's retry picks
  // every completed shard up instead of redoing it.
  try {
    await Promise.all(workers);
  } catch (error) {
    if (error instanceof ShardPlacementFailedError && meta.largePdfProcessing) {
      // Placement failed before a fresh submit existed. Adopted siblings
      // may still be running server-side, but the recorded job id is not
      // theirs — clearing is the honest state (never claims processing
      // that this attempt cannot name; their finished work still lands
      // for the retry via adoption).
      meta.largePdfProcessing.current = undefined;
    }
    throw error;
  }

  // Every shard reached a terminal state and its result was fetched —
  // nothing "continues" from here on, regardless of how the local merge,
  // HTML conversion, or cache save below turn out (mirrors the
  // single-job path's clear in async.ts). A shard FAILURE deliberately
  // leaves the state in place: sibling shards keep running server-side,
  // so "processing continues" stays true for the document.
  if (meta.largePdfProcessing) {
    meta.largePdfProcessing.current = undefined;
  }

  const merged = mergeShardResults(
    ranges.map((range, i) => ({ range, result: results[i] })),
    args.pageMarkers,
  );
  const processorResult: PDFProcessorResult & { markdown: string } = {
    ...merged,
    html: await safeMarkdownToHtml(merged.markdown, meta.logger, meta.id),
  };

  meta.logger.info("FirePDF sharded document merged", {
    method: "scrapePDF/firePdfSharded",
    scrape_id: meta.id,
    shards: ranges.length,
    markdown_length: processorResult.markdown.length,
    pages_processed: processorResult.pagesProcessed,
  });

  // The merged result is the WHOLE document under the raw-sha key — the
  // same key the by-reference flow checks before upload — so the next
  // scrape of these bytes is a pure cache hit. (Shard-scoped saves are
  // suppressed by cacheKeyShape; this is the one save for the doc.)
  const cacheSha256 = args.localSha256 ?? placedSha256;
  if (args.cacheable && cacheSha256) {
    await maybeSaveResult({
      meta,
      base64Content: { key: `raw-${cacheSha256}` },
      mode: args.mode,
      maxPages: undefined,
      includePageMarkdown: args.includePageMarkdown,
      includeBlocks: args.includeBlocks,
      pageMarkers: args.pageMarkers,
      result: processorResult,
    });
  }

  return processorResult;
}

/**
 * Adopt-or-submit one shard. Mirrors the whole-document flow: a
 * content-level lookup first (a retry's shards are new scrape_ids, so
 * only adoption can join the previous attempt's in-flight shard jobs),
 * then a fresh submit under a derived job id.
 */
async function runOneShard(
  args: ShardedAttemptArgs,
  getUploaded: () => Promise<FirePdfByReferenceInput>,
  range: [number, number],
  shardIndex: number,
  /** Shard-local processing container. The whole-document view in
   * runShardedFirePdfAttempt derives its status from these, so shard
   * writes surface without overwriting whole-document page counts. */
  shardContainer: NonNullable<Meta["largePdfProcessing"]>,
): Promise<PDFProcessorResult> {
  const shardPages = range[1] - range[0];
  const shardMeta: Meta = {
    ...args.meta,
    largePdfProcessing: shardContainer,
    logger: args.meta.logger.child({
      method: "scrapePDF/firePdfShard",
      shard: shardIndex,
      page_range: range,
    }),
  };
  const adoptable = args.localSha256
    ? await lookupAdoptableFirePdfJob(
        shardMeta,
        args.localSha256,
        buildFirePdfJobOptions({
          maxPages: undefined,
          pagesProcessed: shardPages,
          mode: args.mode,
          includePageMarkdown: args.includePageMarkdown,
          includeBlocks: args.includeBlocks,
          pageMarkers: args.pageMarkers,
          pageRange: range,
        }),
      )
    : null;
  shardMeta.abort.throwIfAborted();
  const submitShard = async (
    input: FirePdfByReferenceInput | FirePdfAdoptedJobInput,
  ) =>
    scrapePDFWithFirePDFAsync(
      shardMeta,
      input,
      undefined,
      shardPages,
      args.mode,
      undefined,
      args.includePageMarkdown,
      args.includeBlocks,
      args.pageMarkers,
      { pageRange: range, scrapeIdOverride: `${args.meta.id}_s${shardIndex}` },
    );
  if (adoptable) {
    try {
      return await submitShard(adoptable);
    } catch (error) {
      // Mirrors the whole-document adoption fallback: an adopted shard
      // that died (expired/failed) or errored must not fail the attempt
      // when a fresh submit can still succeed — except when this
      // caller's own budget is gone, where resubmitting cannot help.
      shardMeta.abort.throwIfAborted();
      if (
        error instanceof FirePdfAsyncFailure &&
        (error.reason === "polling_timeout" ||
          error.reason === "deadline_too_close")
      ) {
        throw error;
      }
      shardMeta.logger.warn(
        "Adopted shard job did not deliver; submitting fresh",
        {
          method: "scrapePDF/firePdfShard",
          event: "fire_pdf_shard_adoption_fallthrough",
          error,
          adopted_scrape_id: adoptable.adoptScrapeId,
          shard: shardIndex,
        },
      );
    }
  }
  return submitShard(await getUploaded());
}
