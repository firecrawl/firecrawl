export type NuqBackend = "pg" | "fdb";

export type NuqServiceTopology = {
  forcedFdb: boolean;
  fdbConfigured: boolean;
  postgres: boolean;
  pgScrapeWorkers: number;
  fdbScrapeWorkers: number;
  pgPrefetch: boolean;
  pgReconciler: boolean;
  fdbMaintenance: boolean;
  fdbCrawlFinished: boolean;
};

export function resolveNuqServiceTopology(options: {
  backend?: NuqBackend;
  fdbClusterFile?: string;
  scrapeWorkerCount: number;
}): NuqServiceTopology {
  if (!Number.isInteger(options.scrapeWorkerCount)) {
    throw new Error("NuQ scrape worker count must be an integer");
  }
  if (options.scrapeWorkerCount < 0) {
    throw new Error("NuQ scrape worker count cannot be negative");
  }

  const forcedFdb = options.backend === "fdb";
  const forcedPg = options.backend === "pg";
  const fdbConfigured =
    !forcedPg && (forcedFdb || Boolean(options.fdbClusterFile));

  return {
    forcedFdb,
    fdbConfigured,
    postgres: !forcedFdb,
    pgScrapeWorkers: forcedFdb ? 0 : options.scrapeWorkerCount,
    fdbScrapeWorkers: fdbConfigured ? options.scrapeWorkerCount : 0,
    pgPrefetch: !forcedFdb,
    pgReconciler: !forcedFdb,
    // These are deliberately independent of scrape worker count. FDB delayed
    // work, expired leases, and crawl completion must continue to make
    // progress while scrape consumers are scaled to zero during a drain.
    fdbMaintenance: fdbConfigured,
    fdbCrawlFinished: fdbConfigured,
  };
}
