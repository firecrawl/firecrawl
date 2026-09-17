import "dotenv/config";
import { clickhouseClient } from "./clickhouse-client";
import { removeJobFromGCS } from "./gcs-jobs";
import { logger as _logger } from "./logger";
import { config } from "../config";
import { setSpanAttributes, withSpan } from "./otel-tracer";

export async function sendZdrHeartbeat() {
  if (config.ZDRCLEANER_HEARTBEAT_URL) {
    fetch(config.ZDRCLEANER_HEARTBEAT_URL).catch(() => {});
  }
}

async function removeBlobs(blobIds: string[]): Promise<unknown[]> {
  const logger = _logger.child({
    module: "zdrcleaner",
    method: "removeBlobs",
    zeroDataRetention: true,
  });
  const results = await Promise.allSettled(
    blobIds.map(blobId => removeJobFromGCS(blobId, logger)),
  );
  return results.flatMap(result =>
    result.status === "rejected" ? [result.reason] : [],
  );
}

/**
 * Every result blob a request produced, from the `request_children` table
 * (see ../../clickhouse/0001_request_children.sql), which materialized views
 * fill from the Pub/Sub-ingested scrapes, searches, extracts, maps, llmstxts
 * and deep_researches rows. Cleanup runs 24 hours after the request, far
 * beyond ClickPipes ingest lag, so the index is complete by the time it is
 * read.
 */
async function getRequestBlobIds(requestId: string): Promise<string[]> {
  return withSpan("zdr.clickhouse.read_blobs", async span => {
    setSpanAttributes(span, {
      "db.system": "clickhouse",
      "db.operation.name": "select",
      "db.collection.name": "request_children",
      "zdr.request_id": requestId,
    });
    if (clickhouseClient === null) {
      throw new Error(
        "ClickHouse is not configured; cannot resolve ZDR request blobs",
      );
    }
    const result = await clickhouseClient.query({
      query:
        "SELECT DISTINCT id FROM request_children WHERE request_id = {requestId: UUID}",
      query_params: { requestId },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ id: string }>();
    const blobIds = rows.map(row => row.id);
    setSpanAttributes(span, {
      "db.response.returned_rows": blobIds.length,
    });
    return blobIds;
  });
}

export async function cleanZdrRequest(requestId: string): Promise<void> {
  await withSpan("zdr.cleanup.request", async span => {
    setSpanAttributes(span, { "zdr.request_id": requestId });
    const blobIds = await getRequestBlobIds(requestId);
    setSpanAttributes(span, { "zdr.blob_count": blobIds.length });
    if (blobIds.length === 0) {
      _logger.warn("ZDR request has no indexed result blobs", {
        module: "zdrcleaner",
        method: "cleanZdrRequest",
        zeroDataRetention: true,
        requestId,
      });
    }
    const errors = await removeBlobs(blobIds);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to remove ${errors.length} blobs for ZDR request ${requestId}`,
      );
    }
    setSpanAttributes(span, { "zdr.cleanup.outcome": "completed" });
  });
}
