import { RateLimiterMode } from "../../types";
import type {
  CrawlStatusParams,
  CrawlStatusResponse,
  Document,
  ErrorResponse,
  RequestWithAuth,
} from "./types";
import type { WebSocket } from "ws";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../lib/logger";
import {
  getCrawl,
  getCrawlError,
  getCrawlExpiry,
  getCrawlJobs,
  getDoneJobsOrdered,
} from "../../lib/crawl-redis";
import type { PseudoJob } from "./crawl-status";
import { getJobs } from "./crawl-status";
import { getConcurrencyLimitedJobs } from "../../lib/concurrency-limit";
import type { NuQJobStatus } from "../../services/worker/nuq-router";
import { scrapeQueue } from "../../services/worker/nuq-router";
import { z } from "zod";
import { service } from "../../service";

const callerOrgSchema = z.object({ orgId: z.string().nullable() });

type ErrorMessage = {
  type: "error";
  error: string;
};

type CatchupMessage = {
  type: "catchup";
  data: CrawlStatusResponse;
};

type DocumentMessage = {
  type: "document";
  data: Document;
};

type DoneMessage = { type: "done" };

type Message = ErrorMessage | CatchupMessage | DoneMessage | DocumentMessage;

function send(ws: WebSocket, msg: Message) {
  if (ws.readyState === 1) {
    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify(msg), err => {
        if (err) {
          reject(err);
        } else {
          resolve(null);
        }
      });
    });
  }
}

function close(ws: WebSocket, code: number, msg: Message) {
  if (ws.readyState <= 1) {
    ws.close(code, JSON.stringify(msg));
  }
}

async function crawlStatusWS(
  ws: WebSocket,
  req: RequestWithAuth<CrawlStatusParams, undefined, undefined>,
) {
  const sc = await getCrawl(req.params.jobId);
  if (!sc) {
    return close(ws, 1008, { type: "error", error: "Job not found" });
  }

  if (sc.team_id !== req.auth.team_id) {
    return close(ws, 3003, { type: "error", error: "Forbidden" });
  }

  let doneJobIDs: Array<string> = [];
  let finished = false;

  const scheduleLoop = () => {
    setTimeout(() => {
      loop().catch((error: unknown) => {
        finished = true;
        logger.error("Crawl status WS polling failed", {
          error,
          jobId: req.params.jobId,
        });
        close(ws, 1011, { type: "error", error: "Polling failed" });
      });
    }, 1000);
  };

  const loop = async () => {
    if (finished) {
      return;
    }

    const jobIDs = await getCrawlJobs(req.params.jobId);

    if (jobIDs.length === doneJobIDs.length) {
      return close(ws, 1000, { type: "done" });
    }

    const notDoneJobIDs = jobIDs.filter(x => !doneJobIDs.includes(x));

    const newlyDoneJobIDs: Array<string> = (
      await scrapeQueue.getJobsWithStatuses(notDoneJobIDs, [
        "completed",
        "failed",
      ])
    ).map(x => x.id);

    const newlyDoneJobs: Array<PseudoJob<Document>> = await getJobs(
      newlyDoneJobIDs,
      logger,
    );

    for (const job of newlyDoneJobs) {
      if (job.returnvalue) {
        void send(ws, {
          type: "document",
          data: job.returnvalue,
        });
      } else {
        // Crawl errors are ignored.
      }
    }

    doneJobIDs.push(...newlyDoneJobIDs);
    scheduleLoop();
  };

  scheduleLoop();

  const [_doneJobIDs, initialJobIDs, throttledJobsSet] = await Promise.all([
    getDoneJobsOrdered(req.params.jobId),
    getCrawlJobs(req.params.jobId),
    getConcurrencyLimitedJobs(req.auth.team_id),
  ]);
  let jobIDs = initialJobIDs;

  doneJobIDs = _doneJobIDs;
  const jobs = new Map((await scrapeQueue.getJobs(jobIDs)).map(x => [x.id, x]));

  const validJobStatuses: Array<[string, NuQJobStatus]> = [];
  const validJobIDs: Array<string> = [];

  for (const id of jobIDs) {
    if (throttledJobsSet.has(id)) {
      validJobStatuses.push([id, "queued"]);
      validJobIDs.push(id);
    } else {
      const job = jobs.get(id);
      if (job && job.status !== "failed") {
        validJobStatuses.push([id, job.status]);
        validJobIDs.push(id);
      }
    }
  }

  // Check if the crawl failed during kickoff (e.g. queue full)
  const crawlError = await getCrawlError(req.params.jobId);

  let status: Exclude<CrawlStatusResponse, ErrorResponse>["status"] =
    sc.cancelled
      ? "cancelled"
      : validJobStatuses.every(x => x[1] === "completed")
        ? "completed"
        : "scraping";

  if (crawlError && jobIDs.length === 0 && status === "completed") {
    status = "failed";
  }

  jobIDs = validJobIDs; // Use validJobIDs instead of jobIDs for further processing

  const doneJobs = await getJobs(doneJobIDs, logger);
  const data = doneJobs
    .map(x => x.returnvalue)
    .filter((doc): doc is Document => doc !== null);

  if (status === "failed" && crawlError) {
    await send(ws, {
      type: "catchup",
      data: {
        success: false,
        error: crawlError,
        status: "failed",
        total: 0,
        completed: 0,
        creditsUsed: 0,
        expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
        data: [],
      },
    });
    finished = true;
    return close(ws, 1000, { type: "done" });
  }

  await send(ws, {
    type: "catchup",
    data: {
      success: true,
      status,
      total: jobIDs.length,
      completed: doneJobIDs.length,
      creditsUsed: jobIDs.length,
      expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
      data,
    },
  });

  if (status !== "scraping") {
    finished = true;
    return close(ws, 1000, { type: "done" });
  }
}

// Basically just middleware and error wrapping
export async function crawlStatusWSController(
  ws: WebSocket,
  req: RequestWithAuth<CrawlStatusParams, undefined, undefined>,
) {
  try {
    const auth = await service.modules.auth.authenticate(req, {
      kind: RateLimiterMode.CrawlStatus,
    });

    if (!auth.ok) {
      return close(ws, 3000, {
        type: "error",
        error: auth.refusal.body.error,
      });
    }

    const orgParsed = callerOrgSchema.safeParse(auth.caller);
    req.caller = auth.caller;
    req.auth = {
      team_id: auth.caller.teamId,
      org_id: orgParsed.success ? orgParsed.data.orgId : null,
    };

    await crawlStatusWS(ws, req);
  } catch (error) {
    const id = uuidv7();
    let verbose = JSON.stringify(error);
    if (verbose === "{}") {
      if (error instanceof Error) {
        verbose = JSON.stringify({
          message: error.message,
          name: error.name,
          stack: error.stack,
        });
      }
    }

    logger.error(
      "Error occurred in WebSocket! (" +
        req.path +
        ") -- ID " +
        id +
        " -- " +
        verbose,
    );
    return close(ws, 1011, {
      type: "error",
      error: service.modules.messages.errorContact(id),
    });
  }
}
