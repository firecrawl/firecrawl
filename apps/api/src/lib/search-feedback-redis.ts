import { config } from "../config";
import { redisEvictConnection } from "../services/redis";

export type SelfHostedSearchFeedbackJob = {
  id: string;
  requestId: string;
  teamId: string;
  creditsCost: number;
  createdAt: number;
  isSuccessful: boolean;
  zeroDataRetention: boolean;
};

export type SelfHostedSearchFeedbackSubmission = {
  id: string;
  jobId: string;
  teamId: string;
  createdAt: number;
  feedback: unknown;
};

const jobKey = (jobId: string) => `search-feedback:job:${jobId}`;
const submissionKey = (jobId: string) => `search-feedback:submission:${jobId}`;

// Keep the job marker briefly after the submission window closes so the API
// can distinguish an expired search from a search that never existed.
const jobRetentionSeconds = () =>
  Math.max(config.SEARCH_FEEDBACK_MAX_AGE_SEC + 60, 300);

// Self-hosted feedback is operational data owned by the deployment. Redis is
// already required by Firecrawl, so retain submissions there without adding a
// second database requirement.
const FEEDBACK_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export async function saveSelfHostedSearchFeedbackJob(
  job: SelfHostedSearchFeedbackJob,
): Promise<void> {
  await redisEvictConnection.set(
    jobKey(job.id),
    JSON.stringify(job),
    "EX",
    jobRetentionSeconds(),
  );
}

export async function getSelfHostedSearchFeedbackJob(
  jobId: string,
): Promise<SelfHostedSearchFeedbackJob | null> {
  const stored = await redisEvictConnection.get(jobKey(jobId));
  return stored ? (JSON.parse(stored) as SelfHostedSearchFeedbackJob) : null;
}

export async function createSelfHostedSearchFeedbackSubmission(
  submission: SelfHostedSearchFeedbackSubmission,
): Promise<boolean> {
  const result = await redisEvictConnection.set(
    submissionKey(submission.jobId),
    JSON.stringify(submission),
    "EX",
    FEEDBACK_RETENTION_SECONDS,
    "NX",
  );
  return result === "OK";
}

export async function getSelfHostedSearchFeedbackSubmission(
  jobId: string,
): Promise<SelfHostedSearchFeedbackSubmission | null> {
  const stored = await redisEvictConnection.get(submissionKey(jobId));
  return stored
    ? (JSON.parse(stored) as SelfHostedSearchFeedbackSubmission)
    : null;
}
