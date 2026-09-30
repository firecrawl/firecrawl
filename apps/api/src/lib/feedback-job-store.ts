import { config } from "../config";
import type { ScrapeOptions } from "../controllers/v2/types";
import { includesFormat } from "./format-utils";
import { getBigtableTable } from "./bigtable-client";
import { saltedUuidV7RowKey } from "./bigtable-row-key";
import { setSpanAttributes, withSpan } from "./otel-tracer";

const FAMILY = "f";
const QUALIFIER = "v";

type FeedbackEndpoint = "search" | "scrape" | "parse" | "map";
export type RefundClass =
  | "search"
  | "map"
  | "parse"
  | "scrape_basic"
  | "scrape_pdf"
  | "scrape_json"
  | "scrape_addon";

const REFUND_CLASSES: readonly RefundClass[] = [
  "search",
  "map",
  "parse",
  "scrape_basic",
  "scrape_pdf",
  "scrape_json",
  "scrape_addon",
];

type FeedbackJob = {
  requestId: string;
  teamId: string;
  refundClass: RefundClass;
  feedbackDeadlineMs: number;
  succeeded: boolean;
  creditsBilled: number;
  zeroDataRetention: boolean;
};

function parseFeedbackJob(value: Buffer | string): FeedbackJob {
  const parsed: unknown = JSON.parse(value.toString());
  const row = parsed as Record<string, unknown>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    row.version !== 1 ||
    typeof row.requestId !== "string" ||
    typeof row.teamId !== "string" ||
    typeof row.refundClass !== "string" ||
    !REFUND_CLASSES.includes(row.refundClass as RefundClass) ||
    typeof row.feedbackDeadlineMs !== "number" ||
    !Number.isFinite(row.feedbackDeadlineMs) ||
    typeof row.succeeded !== "boolean" ||
    typeof row.creditsBilled !== "number" ||
    !Number.isFinite(row.creditsBilled) ||
    typeof row.zeroDataRetention !== "boolean"
  ) {
    throw new Error("Invalid Bigtable feedback job row");
  }
  // The stored shape carries a `version` for forward compatibility; the
  // in-memory job does not, matching the scrape and extract state readers.
  const { version: _, ...job } = row;
  return job as FeedbackJob;
}

export async function readFeedbackJob(
  jobId: string,
): Promise<FeedbackJob | null> {
  const tableId = config.BIGTABLE_FEEDBACK_JOBS_TABLE;
  if (!tableId) return null;

  return withSpan("bigtable.feedback_job.read", async span => {
    setSpanAttributes(span, {
      "db.system": "bigtable",
      "bigtable.table": tableId,
      "bigtable.operation": "getRows",
    });
    const table = await getBigtableTable(tableId);
    const [rows] = await table.getRows({
      keys: [saltedUuidV7RowKey(jobId)],
      filter: [{ column: { name: QUALIFIER, cellLimit: 1 } }],
    });
    const cells = rows[0]?.data?.[FAMILY]?.[QUALIFIER];
    const cell = Array.isArray(cells) ? cells[0] : undefined;
    if (cell?.value == null) {
      setSpanAttributes(span, { "bigtable.read.outcome": "not_found" });
      return null;
    }

    const job = parseFeedbackJob(cell.value);
    if (job.feedbackDeadlineMs <= Date.now()) {
      setSpanAttributes(span, { "bigtable.read.outcome": "expired" });
      return job;
    }
    setSpanAttributes(span, {
      "bigtable.read.outcome": "found",
      "feedback.refund_class": job.refundClass,
    });
    return job;
  });
}

function scrapeRefundClass(options: ScrapeOptions): RefundClass {
  if (
    options.parsers?.some(
      parser =>
        parser === "pdf" ||
        (typeof parser === "object" && parser.type === "pdf"),
    )
  ) {
    return "scrape_pdf";
  }
  if (includesFormat(options.formats, "json")) return "scrape_json";
  if (
    includesFormat(options.formats, "screenshot") ||
    (options.actions?.length ?? 0) > 0
  ) {
    return "scrape_addon";
  }
  return "scrape_basic";
}

type FeedbackJobBase = {
  jobId: string;
  requestId: string;
  teamId: string;
  succeeded: boolean;
  creditsBilled: number;
  zeroDataRetention: boolean;
  completedAt?: Date;
};

type FeedbackJobWrite = FeedbackJobBase &
  (
    | { endpoint: "scrape"; scrapeOptions: ScrapeOptions }
    | { endpoint: Exclude<FeedbackEndpoint, "scrape"> }
  );

export async function writeFeedbackJob(
  params: FeedbackJobWrite,
): Promise<boolean> {
  const tableId = config.BIGTABLE_FEEDBACK_JOBS_TABLE;
  if (!tableId) return false;

  return withSpan(
    "bigtable.feedback_job.write",
    async span => {
      setSpanAttributes(span, {
        "db.system": "bigtable",
        "bigtable.table": tableId,
        "bigtable.operation": "mutate",
        "feedback.endpoint": params.endpoint,
      });
      const completedAt = params.completedAt ?? new Date();
      const feedbackWindowSec =
        params.endpoint === "search"
          ? config.SEARCH_FEEDBACK_MAX_AGE_SEC
          : config.FEEDBACK_MAX_AGE_SEC;
      const feedbackDeadline = new Date(
        completedAt.getTime() + feedbackWindowSec * 1000,
      );
      const value = Buffer.from(
        JSON.stringify({
          version: 1,
          requestId: params.requestId,
          teamId: params.teamId,
          refundClass:
            params.endpoint === "scrape"
              ? scrapeRefundClass(params.scrapeOptions)
              : params.endpoint,
          feedbackDeadlineMs: feedbackDeadline.getTime(),
          succeeded: params.succeeded,
          creditsBilled: params.creditsBilled,
          zeroDataRetention: params.zeroDataRetention,
        }),
      );
      const table = await getBigtableTable(tableId);
      await table.mutate([
        {
          key: saltedUuidV7RowKey(params.jobId),
          method: "insert",
          data: {
            [FAMILY]: {
              [QUALIFIER]: {
                value,
                timestamp: feedbackDeadline,
              },
            },
          },
        },
      ]);
      return true;
    },
    { zeroDataRetention: params.zeroDataRetention },
  );
}
