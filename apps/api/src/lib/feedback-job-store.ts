import { config } from "../config";
import type { ScrapeOptions } from "../controllers/v2/types";
import { includesFormat } from "./format-utils";
import { getBigtableTable } from "./bigtable-client";
import { saltedUuidV7RowKey } from "./bigtable-row-key";
import { setSpanAttributes, withSpan } from "./otel-tracer";

const FAMILY = "f";
const QUALIFIER = "v";

type FeedbackEndpoint = "search" | "scrape" | "parse" | "map";
type RefundClass =
  | "search"
  | "map"
  | "parse"
  | "scrape_basic"
  | "scrape_pdf"
  | "scrape_json"
  | "scrape_addon";

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
