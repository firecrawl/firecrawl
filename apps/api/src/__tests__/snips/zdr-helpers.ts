import { readFile, stat } from "node:fs/promises";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import { waitForJobLogRows } from "./job-log";

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

type JobRow = Record<string, unknown>;

// Scrape and crawl options are stored as a JSON string; ZDR rows carry none.
function expectNoStoredContent(row: JobRow) {
  expect(String(row.url)).not.toContain("://"); // no url stored
  expect(row.options ?? null).toBeNull();
}

export async function expectScrapeIsCleanedUp(scrapeId: string) {
  const scrapeData = await waitForJobLogRows("scrapes", "id = {id: UUID}", {
    id: scrapeId,
  });

  expect(scrapeData).toHaveLength(1);
  expectNoStoredContent(scrapeData[0]);
}

export async function expectCrawlIsCleanedUp(crawlId: string) {
  const requestData = await waitForJobLogRows("requests", "id = {id: UUID}", {
    id: crawlId,
  });

  expect(requestData).toHaveLength(1);
  expect(requestData[0].kind).toBe("crawl");

  const crawlData = await waitForJobLogRows("crawls", "id = {id: UUID}", {
    id: crawlId,
  });

  expect(crawlData).toHaveLength(1);
  expectNoStoredContent(crawlData[0]);
}

export async function expectBatchScrapeIsCleanedUp(batchScrapeId: string) {
  const requestData = await waitForJobLogRows("requests", "id = {id: UUID}", {
    id: batchScrapeId,
  });

  expect(requestData).toHaveLength(1);
  expect(requestData[0].kind).toBe("batch_scrape");

  const batchScrapeData = await waitForJobLogRows(
    "batch_scrapes",
    "id = {id: UUID}",
    { id: batchScrapeId },
  );

  expect(batchScrapeData).toHaveLength(1);
}

export async function expectScrapesOfRequestAreCleanedUp(
  requestId: string,
  expectedScrapeCount?: number,
) {
  const scrapes = await waitForJobLogRows(
    "scrapes",
    "request_id = {requestId: UUID}",
    { requestId },
    { min: expectedScrapeCount ?? 1 },
  );

  if (expectedScrapeCount !== undefined) {
    expect(scrapes.length).toBe(expectedScrapeCount);
  } else {
    expect(scrapes.length).toBeGreaterThanOrEqual(1);
  }

  for (const scrape of scrapes) {
    expectNoStoredContent(scrape);

    if (scrape.is_successful) {
      const gcsJob = await getJobFromGCS(String(scrape.id));
      expect(gcsJob).not.toBeNull(); // clean up happens async on a worker after expiry
    }
  }

  return scrapes;
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
