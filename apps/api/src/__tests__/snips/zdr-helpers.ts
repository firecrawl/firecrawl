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
  "nuqAddGroup metrics",
  "nuqGetGroup metrics",
  "NuQ job prefetch sent",
  "Acquired job",
  "nuqGetJob metrics",
  "nuqJobFinish metrics",
  "Starting to update tallies",
  "tally for team",
  "Finished updating tallies",
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

export async function expectScrapeIsCleanedUp(scrapeId: string) {
  const { data: scrapeData, error: scrapeError } = await supabase_service
    .from("scrapes")
    .select("*")
    .eq("id", scrapeId)
    .limit(1);

  expect(scrapeError).toBeFalsy();
  expect(scrapeData).toHaveLength(1);

  if (scrapeData && scrapeData.length === 1) {
    const record = scrapeData[0];
    expect(record.url).not.toContain("://"); // no url stored
    expect(record.options).toBeNull();
  }
}

export async function expectCrawlIsCleanedUp(crawlId: string) {
  const { data: requestData, error: requestError } = await supabase_service
    .from("requests")
    .select("*")
    .eq("id", crawlId)
    .limit(1);

  expect(requestError).toBeFalsy();
  expect(requestData).toHaveLength(1);
  
  if (requestData && requestData.length === 1) {
    const record = requestData[0];
    expect(record.url).not.toContain("://"); // no url stored
    expect(record.kind).toBe("crawl");
    expect(record.dr_clean_by).not.toBeNull();
  }

  const { data: crawlData, error: crawlError } = await supabase_service
    .from("crawls")
    .select("*")
    .eq("id", crawlId)
    .limit(1);

  expect(crawlError).toBeFalsy();
  expect(crawlData).toHaveLength(1);

  if (crawlData && crawlData.length === 1) {
    const record = crawlData[0];
    expect(record.url).not.toContain("://"); // no url stored
    expect(record.options).toBeNull();
  }
}

export async function expectBatchScrapeIsCleanedUp(batchScrapeId: string) {
  const { data: requestData, error: requestError } = await supabase_service
    .from("requests")
    .select("*")
    .eq("id", batchScrapeId)
    .limit(1);

  expect(requestError).toBeFalsy();
  expect(requestData).toHaveLength(1);
  
  if (requestData && requestData.length === 1) {
    const record = requestData[0];
    expect(record.url).not.toContain("://"); // no url stored
    expect(record.kind).toBe("batch_scrape");
    expect(record.dr_clean_by).not.toBeNull();
  }

  const { data: batchScrapeData, error: batchScrapeError } = await supabase_service
    .from("batch_scrapes")
    .select("*")
    .eq("id", batchScrapeId)
    .limit(1);

  expect(batchScrapeError).toBeFalsy();
  expect(batchScrapeData).toHaveLength(1);

  if (batchScrapeData && batchScrapeData.length === 1) {
    const record = batchScrapeData[0];
    expect(record.url).not.toContain("://"); // no url stored
  }
}

export async function expectScrapesOfRequestAreCleanedUp(
  requestId: string,
  expectedScrapeCount?: number,
) {
  const { data: scrapes, error: scrapesError } = await supabase_service
    .from("scrapes")
    .select("*")
    .eq("request_id", requestId);

  expect(scrapesError).toBeFalsy();

  if (expectedScrapeCount !== undefined) {
    expect((scrapes ?? []).length).toBe(expectedScrapeCount);
  } else {
    expect((scrapes ?? []).length).toBeGreaterThanOrEqual(1);
  }

  for (const scrape of scrapes ?? []) {
    expect(scrape.url).not.toContain("://"); // no url stored
    expect(scrape.options).toBeNull();

    if (scrape.success) {
      const gcsJob = await getJobFromGCS(scrape.id);
      expect(gcsJob).not.toBeNull(); // clean up happens async on a worker after expiry
    }
  }

  return scrapes ?? [];
}

export async function expectScrapesAreFullyCleanedAfterZDRCleaner(
  scrapes: any[],
  scope: "Team-scoped" | "Request-scoped",
  identity: Identity,
  scrapeStatusRaw: ScrapeStatusRawFn,
) {
  for (const scrape of scrapes) {
    const gcsJob = await getJobFromGCS(scrape.id);
    expect(gcsJob).toBeNull();

    if (scope === "Request-scoped") {
      const status = await scrapeStatusRaw(scrape.id, identity);
      expect(status.statusCode).toBe(404);
    }
  }
}
