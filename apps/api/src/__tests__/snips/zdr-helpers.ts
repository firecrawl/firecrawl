import { readFile, stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
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
  const scrapeData = await db
    .select()
    .from(schema.scrapes)
    .where(eq(schema.scrapes.id, scrapeId))
    .limit(1);

  expect(scrapeData).toHaveLength(1);

  if (scrapeData.length === 1) {
    const record = scrapeData[0];
    expect(record.url).not.toContain("://"); // no url stored
    expect(record.options).toBeNull();
  }
}

export async function expectCrawlIsCleanedUp(crawlId: string) {
  const requestData = await db
    .select()
    .from(schema.requests)
    .where(eq(schema.requests.id, crawlId))
    .limit(1);

  expect(requestData).toHaveLength(1);

  if (requestData.length === 1) {
    const record = requestData[0];
    expect(record.kind).toBe("crawl");
    expect(record.dr_clean_by).not.toBeNull();
  }

  const crawlData = await db
    .select()
    .from(schema.crawls)
    .where(eq(schema.crawls.id, crawlId))
    .limit(1);

  expect(crawlData).toHaveLength(1);

  if (crawlData.length === 1) {
    const record = crawlData[0];
    expect(record.url).not.toContain("://"); // no url stored
    expect(record.options).toBeNull();
  }
}

export async function expectBatchScrapeIsCleanedUp(batchScrapeId: string) {
  const requestData = await db
    .select()
    .from(schema.requests)
    .where(eq(schema.requests.id, batchScrapeId))
    .limit(1);

  expect(requestData).toHaveLength(1);

  if (requestData.length === 1) {
    const record = requestData[0];
    expect(record.kind).toBe("batch_scrape");
    expect(record.dr_clean_by).not.toBeNull();
  }

  const batchScrapeData = await db
    .select()
    .from(schema.batch_scrapes)
    .where(eq(schema.batch_scrapes.id, batchScrapeId))
    .limit(1);

  expect(batchScrapeData).toHaveLength(1);
}

export async function expectScrapesOfRequestAreCleanedUp(
  requestId: string,
  expectedScrapeCount?: number,
) {
  const scrapes = await db
    .select()
    .from(schema.scrapes)
    .where(eq(schema.scrapes.request_id, requestId));

  if (expectedScrapeCount !== undefined) {
    expect(scrapes.length).toBe(expectedScrapeCount);
  } else {
    expect(scrapes.length).toBeGreaterThanOrEqual(1);
  }

  for (const scrape of scrapes) {
    expect(scrape.url).not.toContain("://"); // no url stored
    expect(scrape.options).toBeNull();

    if (scrape.is_successful) {
      const gcsJob = await getJobFromGCS(scrape.id);
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
