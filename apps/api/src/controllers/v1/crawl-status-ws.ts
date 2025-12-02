import { RateLimiterMode } from "../../types";
import { authenticateUser } from "../auth";
import {
  CrawlStatusParams,
  CrawlStatusResponse,
  Document,
  ErrorResponse,
  RequestWithAuth,
} from "./types";
import { WebSocket } from "ws";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../../lib/logger";
import {
  getCrawl,
  getCrawlExpiry,
  getCrawlJobs,
  getDoneJobsOrdered,
} from "../../lib/crawl-redis";
import { getJobs, PseudoJob } from "./crawl-status";
import * as Sentry from "@sentry/node";
import { getConcurrencyLimitedJobs } from "../../lib/concurrency-limit";
import { scrapeQueue, NuQJobStatus } from "../../services/worker/nuq";
import { getErrorContactMessage } from "../../lib/deployment";

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
        if (err) reject(err);
        else resolve(null);
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

  let doneJobIDs: string[] = [];
  let finished = false;

  const loop = async () => {
    if (finished) return;

    const jobIDs = await getCrawlJobs(req.params.jobId);

    if (jobIDs.length === doneJobIDs.length) {
      return close(ws, 1000, { type: "done" });
    }

    const notDoneJobIDs = jobIDs.filter(x => !doneJobIDs.includes(x));

    const newlyDoneJobIDs: string[] = (
      await scrapeQueue.getJobsWithStatuses(notDoneJobIDs, [
        "completed",
        "failed",
      ])
    ).map(x => x.id);

    const newlyDoneJobs: PseudoJob<any>[] = await getJobs(newlyDoneJobIDs);

    for (const job of newlyDoneJobs) {
      if (job.returnvalue) {
        send(ws, {
          type: "document",
          data: job.returnvalue,
        });
      } else {
        // Crawl errors are ignored.
      }
    }

    doneJobIDs.push(...newlyDoneJobIDs);
    setTimeout(loop, 1000);
  };

  setTimeout(loop, 1000);

  let [_doneJobIDs, jobIDs, throttledJobsSet] = await Promise.all([
    getDoneJobsOrdered(req.params.jobId),
    getCrawlJobs(req.params.jobId),
    getConcurrencyLimitedJobs(req.auth.team_id),
  ]);

  doneJobIDs = _doneJobIDs;
  const jobs = new Map((await scrapeQueue.getJobs(jobIDs)).map(x => [x.id, x]));

  const validJobStatuses: [string, NuQJobStatus][] = [];
  const validJobIDs: string[] = [];

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

  const status: Exclude<CrawlStatusResponse, ErrorResponse>["status"] =
    sc.cancelled
      ? "cancelled"
      : validJobStatuses.every(x => x[1] === "completed")
        ? "completed"
        : "scraping";

  jobIDs = validJobIDs; // Use validJobIDs instead of jobIDs for further processing

  const doneJobs = await getJobs(doneJobIDs);
  const data = doneJobs.map(x => x.returnvalue);

  await send(ws, {
    type: "catchup",
    data: {
      success: true,
      status,
      total: jobIDs.length,
      completed: doneJobIDs.length,
      creditsUsed: jobIDs.length,
      expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
      data: data,
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
    const auth = await authenticateUser(req, null, RateLimiterMode.CrawlStatus);

    if (!auth.success) {
      return close(ws, 3000, {
        type: "error",
        error: auth.error,
      });
    }

    const { team_id } = auth;

    req.auth = { team_id };

    await crawlStatusWS(ws, req);
  } catch (err) {
    Sentry.captureException(err);

    const id = uuidv7();
    let verbose = JSON.stringify(err);
    if (verbose === "{}") {
      if (err instanceof Error) {
        verbose = JSON.stringify({
          message: err.message,
          name: err.name,
          stack: err.stack,
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
      error: getErrorContactMessage(id),
    });
  }
}
