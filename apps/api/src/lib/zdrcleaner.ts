import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { getZdrCleanupBatch } from "../db/rpc";
import { removeJobFromGCS } from "./gcs-jobs";
import { logger as _logger } from "./logger";
import { config } from "../config";
import { setSpanAttributes, withSpan } from "./otel-tracer";

async function sendHeartbeat() {
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

async function getRequestBlobIds(requestId: string): Promise<string[]> {
  return withSpan("zdr.postgres.read_blobs", async span => {
    setSpanAttributes(span, {
      "db.system": "postgresql",
      "db.operation.name": "select",
      "zdr.request_id": requestId,
    });
    const [scrapes, searches, extracts, maps, llmstxts, deepResearches] =
      await Promise.all([
        db
          .select({ id: schema.scrapes.id })
          .from(schema.scrapes)
          .where(eq(schema.scrapes.request_id, requestId)),
        db
          .select({ id: schema.searches.id })
          .from(schema.searches)
          .where(eq(schema.searches.request_id, requestId)),
        db
          .select({ id: schema.extracts.id })
          .from(schema.extracts)
          .where(eq(schema.extracts.request_id, requestId)),
        db
          .select({ id: schema.maps.id })
          .from(schema.maps)
          .where(eq(schema.maps.request_id, requestId)),
        db
          .select({ id: schema.llmstxts.id })
          .from(schema.llmstxts)
          .where(eq(schema.llmstxts.request_id, requestId)),
        db
          .select({ id: schema.deep_researches.id })
          .from(schema.deep_researches)
          .where(eq(schema.deep_researches.request_id, requestId)),
      ]);

    const blobIds = [
      ...scrapes,
      ...searches,
      ...extracts,
      ...maps,
      ...llmstxts,
      ...deepResearches,
    ].map(row => row.id);
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

export async function zdrcleaner() {
  const logger = _logger.child({
    module: "zdrcleaner",
    method: "zdrcleaner",
  });

  const start = Date.now();
  try {
    // Call the RPC to get all blobs (scrapes, searches, extracts, maps, llmstxts, deep_researches)
    // associated with requests that need cleanup.
    // The RPC handles the dr_clean_by filtering logic (team-specific vs scheduled)
    const rows: { request_id: string; ids: string[] }[] =
      await getZdrCleanupBatch(1000);

    if (!rows || rows.length === 0) {
      logger.debug("zdrcleaner batch completed with no rows to process", {
        canonicalLog: "zdrcleaner",
        success: true,
        timeMs: Date.now() - start,
      });
      await sendHeartbeat();
      await new Promise(resolve => setTimeout(resolve, 1000));
      return;
    }

    const deleteErrors: any[] = [];
    const fullyCleanedRequests: string[] = [];
    for (let j = 0; j < Math.ceil(rows.length / 50); j++) {
      const batch = rows.slice(j * 50, (j + 1) * 50);
      await Promise.all(
        batch.map(async row => {
          const errors = await removeBlobs(row.ids);
          if (errors.length === 0) fullyCleanedRequests.push(row.request_id);
          else deleteErrors.push(...errors);
        }),
      );
    }

    const updateErrors: any[] = [];

    if (fullyCleanedRequests.length > 0) {
      try {
        await db
          .update(schema.requests)
          .set({ dr_clean_by: null })
          .where(inArray(schema.requests.id, fullyCleanedRequests));
      } catch (error) {
        updateErrors.push(error);
      }
    }

    await sendHeartbeat();
    if (deleteErrors.length > 0 || updateErrors.length > 0) {
      logger.warn("zdrcleaner batch completed with errors", {
        canonicalLog: "zdrcleaner",
        success: true,
        deleteErrors,
        updateErrors,
        timeMs: Date.now() - start,
      });
    } else {
      logger.debug("zdrcleaner batch completed", {
        canonicalLog: "zdrcleaner",
        success: true,
        deleteErrors,
        timeMs: Date.now() - start,
      });
    }
  } catch (error) {
    logger.error(`Error looping through cleanup batch`, {
      canonicalLog: "zdrcleaner",
      success: false,
      timeMs: Date.now() - start,
      error,
    });
  }
}
