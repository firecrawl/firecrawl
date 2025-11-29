import { supabase_service } from "../../../services/supabase";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import {
  scrape,
  crawl,
  batchScrape,
  scrapeStatusRaw,
  zdrcleaner,
  idmux,
} from "./lib";
import { readFile, stat } from "node:fs/promises";
import { describeIf, TEST_PRODUCTION } from "../lib";

const logIgnoreList = [
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

async function getLogs() {
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
    .filter(x => x.trim().length > 0)
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

describeIf(TEST_PRODUCTION)("Zero Data Retention", () => {
  describe.each(["Team-scoped", "Request-scoped"] as const)("%s", scope => {
    it("should clean up a scrape immediately", async () => {
      let identity = await idmux({
        name: `zdr/${scope}/scrape`,
        credits: 10000,
        flags: {
          allowZDR: true,
          ...(scope === "Team-scoped"
            ? {
                forceZDR: true,
              }
            : {}),
        },
      });

      const testId = crypto.randomUUID();
      const scrape1 = await scrape(
        {
          url: "https://firecrawl.dev/?test=" + testId,
          zeroDataRetention: scope === "Request-scoped" ? true : undefined,
        },
        identity,
      );

      const gcsJob = await getJobFromGCS(scrape1.metadata.scrapeId!);
      expect(gcsJob).toBeNull();

      const { data, error } = await supabase_service
        .from("firecrawl_jobs")
        .select("*")
        .eq("job_id", scrape1.metadata.scrapeId!)
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

      if (scope === "Request-scoped") {
        const status = await scrapeStatusRaw(
          scrape1.metadata.scrapeId!,
          identity,
        );

        expect(status.statusCode).toBe(404);
      }
    }, 60000);

    it("should clean up a crawl", async () => {
      const preLogs = await getLogs();

      let identity = await idmux({
        name: `zdr/${scope}/crawl`,
        credits: 10000,
        flags: {
          allowZDR: true,
          ...(scope === "Team-scoped"
            ? {
                forceZDR: true,
              }
            : {}),
        },
      });

      const crawl1 = await crawl(
        {
          url: "https://firecrawl.dev",
          limit: 10,
          zeroDataRetention: scope === "Request-scoped" ? true : undefined,
        },
        identity,
      );

      const postLogs = (await getLogs()).slice(preLogs.length);

      if (postLogs.length > 0) {
        console.warn("Logs changed during crawl", postLogs);
      }

      expect(postLogs).toHaveLength(0);

      const { data, error } = await supabase_service
        .from("firecrawl_jobs")
        .select("*")
        .eq("job_id", crawl1.id)
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

      const { data: jobs, error: jobsError } = await supabase_service
        .from("firecrawl_jobs")
        .select("*")
        .eq("crawl_id", crawl1.id);

      expect(jobsError).toBeFalsy();
      expect((jobs ?? []).length).toBeGreaterThanOrEqual(1);

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

      await zdrcleaner(identity.teamId!);

      for (const job of jobs ?? []) {
        const gcsJob = await getJobFromGCS(job.job_id);
        expect(gcsJob).toBeNull();

        if (scope === "Request-scoped") {
          const status = await scrapeStatusRaw(job.job_id, identity);
          expect(status.statusCode).toBe(404);
        }
      }
    }, 600000);

    it("should clean up a batch scrape", async () => {
      const preLogs = await getLogs();

      let identity = await idmux({
        name: `zdr/${scope}/batch-scrape`,
        credits: 10000,
        flags: {
          allowZDR: true,
          ...(scope === "Team-scoped"
            ? {
                forceZDR: true,
              }
            : {}),
        },
      });

      const crawl1 = await batchScrape(
        {
          urls: ["https://firecrawl.dev", "https://mendable.ai"],
          zeroDataRetention: scope === "Request-scoped" ? true : undefined,
        },
        identity,
      );

      const postLogs = (await getLogs()).slice(preLogs.length);

      if (postLogs.length > 0) {
        console.warn("Logs changed during batch scrape", postLogs);
      }

      expect(postLogs).toHaveLength(0);

      const { data, error } = await supabase_service
        .from("firecrawl_jobs")
        .select("*")
        .eq("job_id", crawl1.id)
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

      const { data: jobs, error: jobsError } = await supabase_service
        .from("firecrawl_jobs")
        .select("*")
        .eq("crawl_id", crawl1.id);

      expect(jobsError).toBeFalsy();
      expect((jobs ?? []).length).toBe(2);

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

      await zdrcleaner(identity.teamId!);

      for (const job of jobs ?? []) {
        const gcsJob = await getJobFromGCS(job.job_id);
        expect(gcsJob).toBeNull();

        if (scope === "Request-scoped") {
          const status = await scrapeStatusRaw(job.job_id, identity);
          expect(status.statusCode).toBe(404);
        }
      }
    }, 600000);
  });
});
