import "dotenv/config";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { getZdrCleanupBatch } from "../db/rpc";
import { removeJobFromGCS } from "./gcs-jobs";
import { logger as _logger } from "./logger";
import { config } from "../config";

async function sendHeartbeat() {
  if (config.ZDRCLEANER_HEARTBEAT_URL) {
    fetch(config.ZDRCLEANER_HEARTBEAT_URL).catch(() => {});
  }
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

    const requestBlobs = new Map<string, Set<string>>();
    const successfulBlobs = new Set<string>();

    // Track all blobs for each request before processing
    for (const row of rows) {
      requestBlobs.set(row.request_id, new Set(row.ids));
    }

    // Process in batches of 50 for GCS cleanup
    const deleteErrors: any[] = [];
    for (let j = 0; j < Math.ceil(rows.length / 50); j++) {
      const batch = rows.slice(j * 50, (j + 1) * 50);
      await Promise.allSettled(
        batch
          .flatMap(x => x.ids)
          .map(async blob_id => {
            try {
              await removeJobFromGCS(
                blob_id,
                logger.child({ zeroDataRetention: true }),
              );
              successfulBlobs.add(blob_id);
            } catch (error) {
              deleteErrors.push(error);
            }
          }),
      );
    }

    const fullyCleanedRequests: string[] = [];
    for (const [requestId, blobIds] of requestBlobs) {
      const allBlobsCleaned = [...blobIds].every(blobId =>
        successfulBlobs.has(blobId),
      );
      if (allBlobsCleaned) {
        fullyCleanedRequests.push(requestId);
      }
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
