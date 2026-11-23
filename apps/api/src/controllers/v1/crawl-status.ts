import { config } from "../../config";
import { configDotenv } from "dotenv";
import { logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import {
  scrapeQueue,
  NuQJob,
  NuQJobStatus,
} from "../../services/worker/nuq-router";
import { ScrapeJobSingleUrls } from "../../types";
configDotenv();

export type PseudoJob<T> = {
  id: string;
  status: NuQJobStatus;
  returnvalue: T | null;
  timestamp: number;
  data: {
    scrapeOptions: any;
    teamId?: string;
  };
  failedReason?: string;
};

export async function getJobs(ids: string[]): Promise<PseudoJob<any>[]> {
  const [nuqJobs, gcsJobs] = await Promise.all([
    scrapeQueue.getJobs(ids) as Promise<NuQJob<ScrapeJobSingleUrls>[]>,
    config.GCS_BUCKET_NAME
      ? (Promise.all(
          ids.map(async x => ({ id: x, job: await getJobFromGCS(x) })),
        ).then(x => x.filter(x => x.job)) as Promise<
          { id: string; job: any | null }[]
        >)
      : [],
  ]);

  const nuqJobMap = new Map<string, NuQJob<any, any>>();
  const gcsJobMap = new Map<string, any>();

  for (const job of nuqJobs) {
    nuqJobMap.set(job.id, job);
  }

  for (const job of gcsJobs) {
    gcsJobMap.set(job.id, job.job);
  }

  const jobs: PseudoJob<any>[] = [];

  for (const id of ids) {
    const nuqJob = nuqJobMap.get(id);
    const gcsJob = gcsJobMap.get(id);

    if (!nuqJob) continue;

    const data = gcsJob ?? nuqJob.returnvalue;
    if (gcsJob === null && data) {
      logger.warn("GCS Job not found", {
        jobId: id,
      });
    }

    const job: PseudoJob<any> = {
      id,
      status: nuqJob.status,
      returnvalue: Array.isArray(data) ? data[0] : data,
      data: {
        scrapeOptions: nuqJob.data.scrapeOptions,
      },
      timestamp: nuqJob.createdAt.valueOf(),
      failedReason: nuqJob.failedReason || undefined,
    };

    jobs.push(job);
  }

  return jobs;
}
