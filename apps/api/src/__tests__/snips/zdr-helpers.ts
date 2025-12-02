import { readFile, stat } from "node:fs/promises";
import { supabase_service } from "../../services/supabase";
import { getJobFromGCS } from "../../lib/gcs-jobs";

type Identity = { apiKey: string; teamId: string };
type ScrapeStatusRawFn = (
  jobId: string,
  identity: Identity,
) => Promise<{ statusCode: number }>;

export const logIgnoreList = [
  "Billing queue created",
  "No billing operations to process in batch",
  "billing batch queue",
  "billing batch processing lock",
  "Batch billing team",
  "Successfully billed team",
  "Billing batch processing",
  "Processing batch of",
  "Billing team",
  "No jobs to process",
  "nuqHealthCheck metrics",
  "nuqGetJobToProcess metrics",
  "Domain frequency processor",
  "billing operation to batch queue",
  "billing operation to queue",
  "billing operation for team",
  "Added billing operation to queue",
  "Index RF inserter found",
  "Redis connected",
  "Prefetched jobs",
  "nuqPrefetchJobs metrics",
  "request completed",
  "nuqAddJobs metrics",
  "nuqGetJobs metrics",
];

export async function getLogs() {
  const winstonLogFiles = ["firecrawl-app.log", "firecrawl-worker.log"];
  const existingLogFiles: string[] = [];

  for (const file of winstonLogFiles) {
    try {
      await stat(file);
      existingLogFiles.push(file);
    } catch {
      continue;
    }
  }

  if (existingLogFiles.length === 0) {
    console.warn(
      "No log file found (checked firecrawl-app.log, firecrawl-worker.log)",
    );
    return [];
  }

  const allLogs = await Promise.all(
    existingLogFiles.map(file => readFile(file, "utf8")),
  );

  return allLogs
    .join("\n")
    .split("\n")

    .map(line => {
      try {
        const logEntry = JSON.parse(line);
        return logEntry.message || line;
      } catch {
        return line;
      }
    })
    .filter(
      x => x.trim().length > 0 && !logIgnoreList.some(y => x.includes(y)),
    );
}

export async function expectJobRecordIsCleanedUp(jobId: string) {
  const { data, error } = await supabase_service
    .from("firecrawl_jobs")
    .select("*")
    .eq("job_id", jobId)
    .limit(1);

  expect(error).toBeFalsy();
  expect(data).toHaveLength(1);

  if (data && data.length === 1) {
    const record = data[0];
    expect(record.url).not.toContain("://"); // no url stored
    expect(record.docs).toBeNull();
    expect(record.page_options).toBeNull();
    expect(record.crawler_options).toBeNull();
  }
}

export async function expectJobsArrayIsCleanedUp(
  crawlId: string,
  expectedJobCount?: number,
) {
  const { data: jobs, error: jobsError } = await supabase_service
    .from("firecrawl_jobs")
    .select("*")
    .eq("crawl_id", crawlId);

  expect(jobsError).toBeFalsy();

  if (expectedJobCount !== undefined) {
    expect((jobs ?? []).length).toBe(expectedJobCount);
  } else {
    expect((jobs ?? []).length).toBeGreaterThanOrEqual(1);
  }

  for (const job of jobs ?? []) {
    expect(job.url).not.toContain("://"); // no url stored
    expect(job.docs).toBeNull();
    expect(job.page_options).toBeNull();
    expect(job.crawler_options).toBeNull();
    expect(typeof job.dr_clean_by).toBe("string"); // clean up happens async on a worker after expiry

    if (job.success) {
      const gcsJob = await getJobFromGCS(job.job_id);
      expect(gcsJob).not.toBeNull(); // clean up happens async on a worker after expiry
    }
  }

  return jobs ?? [];
}

export async function expectJobsAreFullyCleanedAfterZDRCleaner(
  jobs: any[],
  scope: "Team-scoped" | "Request-scoped",
  identity: Identity,
  scrapeStatusRaw: ScrapeStatusRawFn,
) {
  for (const job of jobs) {
    const gcsJob = await getJobFromGCS(job.job_id);
    expect(gcsJob).toBeNull();

    if (scope === "Request-scoped") {
      const status = await scrapeStatusRaw(job.job_id, identity);
      expect(status.statusCode).toBe(404);
    }
  }
}
