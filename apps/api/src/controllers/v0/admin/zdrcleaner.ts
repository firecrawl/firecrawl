import "dotenv/config";
import { supabase_service } from "../../../services/supabase";
import { removeJobFromGCS } from "../../../lib/gcs-jobs";
import { Request, Response } from "express";
import { logger as _logger } from "../../../lib/logger";
import type { Logger } from "winston";

async function cleanUpJob(jobId: string) {
  await removeJobFromGCS(jobId);
}

async function cleanUpRequests(specificTeamId: string | null, _logger: Logger) {
  const logger = _logger.child({
    ...(specificTeamId ? { teamId: specificTeamId } : {}),
    method: "cleanUpRequests",
  });

  // Track all blobs that need cleanup for each request
  const requestBlobs = new Map<string, Set<string>>();
  // Track which blobs were successfully cleaned up
  const successfulBlobs = new Set<string>();

  try {
    for (let i = 0; ; i++) {
      // Call the RPC to get all blobs (scrapes, searches, extracts, maps, llmstxts, deep_researches)
      // associated with requests that need cleanup.
      // The RPC handles the dr_clean_by filtering logic (team-specific vs scheduled)
      const { data: rows, error } = await supabase_service.rpc(
        "get_zdr_cleanup_batch",
        {
          p_team_id: specificTeamId,
          p_limit: 1000,
          p_offset: i * 1000,
        },
      );

      if (error) {
        logger.error("Error calling get_zdr_cleanup_batch RPC", { error });
        throw error;
      }

      if (!rows || rows.length === 0) {
        break;
      }

      // Track all blobs for each request before processing
      for (const row of rows as { request_id: string; blob_id: string }[]) {
        if (!requestBlobs.has(row.request_id)) {
          requestBlobs.set(row.request_id, new Set());
        }
        requestBlobs.get(row.request_id)!.add(row.blob_id);
      }

      // Process in batches of 50 for GCS cleanup
      for (let j = 0; j < Math.ceil(rows.length / 50); j++) {
        const batch = rows.slice(j * 50, (j + 1) * 50);
        await Promise.allSettled(
          batch.map(async (row: { request_id: string; blob_id: string }) => {
            try {
              await cleanUpJob(row.blob_id);
              successfulBlobs.add(row.blob_id);
            } catch (error) {
              logger.error(`Error cleaning up blob`, {
                method: "cleanUpJob",
                blobId: row.blob_id,
                requestId: row.request_id,
                error,
              });
              // Don't throw - continue with other blobs
            }
          }),
        );
      }

      if (rows.length < 1000) {
        break;
      }
    }
  } catch (error) {
    logger.error(`Error looping through cleanup batch`, {
      error,
    });
  }

  // Only clear dr_clean_by on requests where ALL blobs were successfully cleaned up
  const fullyCleanedRequests: string[] = [];
  for (const [requestId, blobIds] of requestBlobs) {
    const allBlobsCleaned = [...blobIds].every(blobId =>
      successfulBlobs.has(blobId),
    );
    if (allBlobsCleaned) {
      fullyCleanedRequests.push(requestId);
    }
  }

  if (fullyCleanedRequests.length > 0) {
    try {
      await supabase_service
        .from("requests")
        .update({
          dr_clean_by: null,
        })
        .in("id", fullyCleanedRequests)
        .throwOnError();

      logger.info(`Cleaned up ${fullyCleanedRequests.length} requests`);
    } catch (error) {
      logger.error(`Error clearing dr_clean_by on requests`, {
        error,
        requestCount: fullyCleanedRequests.length,
      });
    }
  }
}

export async function zdrcleanerController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "zdrcleaner",
    method: "zdrcleanerController",
  });

  const teamId = (req.query.teamId as string | undefined) ?? null;

  // Clean up requests/scrapes tables
  await cleanUpRequests(teamId, logger);

  logger.info("ZDR Cleaner finished!");

  res.json({ ok: true });
}
