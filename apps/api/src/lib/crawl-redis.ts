import { InternalOptions } from "../scraper/scrapeURL";
import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { WebhookConfig } from "../services/webhook/types";
import { WebCrawler } from "../scraper/WebScraper/crawler";
import { redisEvictConnection } from "../services/redis";
import { logger as _logger } from "./logger";
import { getAdjustedMaxDepth } from "../scraper/WebScraper/utils/maxDepthUtils";
import type { Logger } from "winston";
import { withSpan, setSpanAttributes } from "./otel-tracer";
import { getScrapeZDR, getIgnoreRobots } from "./zdr-helpers";
import {
  firstPipelineError,
  reportPipelineError,
  REDIS_COMMAND_ARG_CHUNK_SIZE,
} from "./redis-pipeline";

export type StoredCrawl = {
  originUrl?: string;
  crawlerOptions: any;
  scrapeOptions: Omit<ScrapeOptions, "timeout">;
  internalOptions: InternalOptions;
  team_id: string;
  robots?: string;
  cancelled?: boolean;
  createdAt: number;
  maxConcurrency?: number;
  zeroDataRetention?: boolean;
  // which queue backend this crawl's group + jobs live on; a crawl never
  // spans backends. Absent on crawls created before the FDB rollout (= pg).
  queueBackend?: "pg" | "fdb";
  // Crawl-scoped context the finish path needs (completion webhook, api version,
  // request id). Persisted here so it survives even when a member job's input
  // data has been shed — which the FDB queue does for ZDR crawls on completion.
  // Absent on crawls created before this was added; the finish path then falls
  // back to reading these off a representative member's job data.
  v1?: boolean;
  webhook?: WebhookConfig;
  requestId?: string;
};

export async function saveCrawl(id: string, crawl: StoredCrawl) {
  return await withSpan("firecrawl-redis-save-crawl", async span => {
    setSpanAttributes(span, {
      "crawl.id": id,
      "crawl.team_id": crawl.team_id,
      "crawl.zero_data_retention": crawl.zeroDataRetention || false,
      operation: "save_crawl",
    });

    _logger.debug("Saving crawl " + id + " to Redis...", {
      crawl,
      module: "crawl-redis",
      method: "saveCrawl",
      crawlId: id,
      teamId: crawl.team_id,
      zeroDataRetention: crawl.zeroDataRetention,
    });

    await redisEvictConnection.set(
      "crawl:" + id,
      JSON.stringify(crawl),
      "EX",
      24 * 60 * 60,
    );
    await redisEvictConnection.sadd("crawls_by_team_id:" + crawl.team_id, id);
    await redisEvictConnection.expire(
      "crawls_by_team_id:" + crawl.team_id,
      24 * 60 * 60,
    );
  });
}

export async function recordRobotsBlocked(crawlId: string, url: string) {
  await redisEvictConnection.sadd("crawl:" + crawlId + ":robots_blocked", url);
  await redisEvictConnection.expire(
    "crawl:" + crawlId + ":robots_blocked",
    24 * 60 * 60,
  );
}

/**
 * Records a URL that was silently skipped during crawl link discovery because
 * it was blocked by the team's threat protection policy. The crawl continues
 * without it; the record (canonical url -> full ThreatDecision JSON) is
 * crawl bookkeeping, and doubles as the crawl-scoped billing dedup for
 * blocked discoveries: returns true only for the first record of a URL
 * within this crawl (HSETNX), so a blocked link that many pages point at
 * (e.g. in a site-wide nav) bills its scan fee once per crawl, not once per
 * page that rediscovered it. Callers key by the decision's canonical URL so
 * raw spelling variants dedupe together, matching billing.
 *
 * ZDR posture: this hash follows the same rules as the rest of the transient
 * crawl bookkeeping in this file (crawl doc, visited sets, robots_blocked) —
 * it necessarily holds URLs while the crawl runs, lives in the evict Redis,
 * and expires after 24h like every other crawl key. Additionally, for
 * zero-data-retention crawls it is deleted eagerly in {@link finishCrawl}.
 */
export async function recordThreatBlocked(
  crawlId: string,
  url: string,
  decision: unknown,
): Promise<boolean> {
  const key = "crawl:" + crawlId + ":threat_blocked";
  const isNew = await redisEvictConnection.hsetnx(
    key,
    url,
    JSON.stringify(decision),
  );
  await redisEvictConnection.expire(key, 24 * 60 * 60);
  return isNew === 1;
}

export async function markCrawlActive(id: string) {
  await redisEvictConnection.sadd("active_crawls", id);
}

export async function getCrawl(id: string): Promise<StoredCrawl | null> {
  return await withSpan("firecrawl-redis-get-crawl", async span => {
    setSpanAttributes(span, {
      "crawl.id": id,
      operation: "get_crawl",
    });

    const x = await redisEvictConnection.get("crawl:" + id);

    if (x === null) {
      setSpanAttributes(span, { "crawl.found": false });
      return null;
    }

    await redisEvictConnection.expire("crawl:" + id, 24 * 60 * 60);
    const crawl = JSON.parse(x);

    setSpanAttributes(span, {
      "crawl.found": true,
      "crawl.team_id": crawl.team_id,
    });

    return crawl;
  });
}

export async function getCrawlExpiry(id: string): Promise<Date> {
  const d = new Date();
  const ttl = await redisEvictConnection.pttl("crawl:" + id);
  d.setMilliseconds(d.getMilliseconds() + ttl);
  d.setMilliseconds(0);
  return d;
}

export async function addCrawlJob(
  id: string,
  job_id: string,
  __logger: Logger = _logger,
) {
  return await withSpan("firecrawl-redis-add-crawl-job", async span => {
    setSpanAttributes(span, {
      "crawl.id": id,
      "crawl.job_id": job_id,
      operation: "add_crawl_job",
    });

    __logger.debug("Adding crawl job " + job_id + " to Redis...", {
      jobId: job_id,
      module: "crawl-redis",
      method: "addCrawlJob",
      crawlId: id,
    });

    const pipeline = redisEvictConnection.pipeline();
    pipeline.sadd("crawl:" + id + ":jobs", job_id);
    pipeline.expire("crawl:" + id + ":jobs", 24 * 60 * 60);
    pipeline.sadd("crawl:" + id + ":jobs_qualified", job_id);
    pipeline.expire("crawl:" + id + ":jobs_qualified", 24 * 60 * 60);
    const error = reportPipelineError(await pipeline.exec(), __logger, {
      module: "crawl-redis",
      method: "addCrawlJob",
      crawlId: id,
      jobId: job_id,
    });
    if (error) {
      throw new Error("Failed to add crawl job: " + error.message, {
        cause: error,
      });
    }
  });
}

export async function addCrawlJobs(
  id: string,
  job_ids: string[],
  __logger: Logger = _logger,
) {
  if (job_ids.length === 0) return true;

  __logger.debug("Adding crawl jobs to Redis...", {
    jobIds: job_ids,
    module: "crawl-redis",
    method: "addCrawlJobs",
    crawlId: id,
  });
  const pipeline = redisEvictConnection.pipeline();
  for (let i = 0; i < job_ids.length; i += REDIS_COMMAND_ARG_CHUNK_SIZE) {
    const chunk = job_ids.slice(i, i + REDIS_COMMAND_ARG_CHUNK_SIZE);
    pipeline.sadd("crawl:" + id + ":jobs", ...chunk);
    pipeline.sadd("crawl:" + id + ":jobs_qualified", ...chunk);
  }
  pipeline.expire("crawl:" + id + ":jobs", 24 * 60 * 60);
  pipeline.expire("crawl:" + id + ":jobs_qualified", 24 * 60 * 60);
  const error = reportPipelineError(await pipeline.exec(), __logger, {
    module: "crawl-redis",
    method: "addCrawlJobs",
    crawlId: id,
    jobCount: job_ids.length,
  });
  if (error) {
    throw new Error("Failed to add crawl jobs: " + error.message, {
      cause: error,
    });
  }
}

export async function addCrawlJobDone(
  id: string,
  job_id: string,
  success: boolean,
  __logger: Logger = _logger,
) {
  __logger.debug("Adding done crawl job to Redis...", {
    jobId: job_id,
    module: "crawl-redis",
    method: "addCrawlJobDone",
    crawlId: id,
  });
  // The commands are idempotent, so retry the whole pipeline on failure:
  // callers invoke this on both the success and failure paths of a scrape
  // job, and a throw from the success path would otherwise cascade into the
  // failure path and misreport (and potentially re-run) a finished scrape.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pipeline = redisEvictConnection.pipeline();
      pipeline.sadd("crawl:" + id + ":jobs_done", job_id);
      pipeline.expire("crawl:" + id + ":jobs_done", 24 * 60 * 60);

      if (success) {
        pipeline.zadd(
          "crawl:" + id + ":jobs_donez_ordered",
          Date.now(),
          job_id,
        );
      } else {
        // in case it's already been pushed, make sure it's removed
        pipeline.zrem("crawl:" + id + ":jobs_donez_ordered", job_id);
      }

      pipeline.expire("crawl:" + id + ":jobs_donez_ordered", 24 * 60 * 60);
      const error = firstPipelineError(await pipeline.exec());
      if (error === null) {
        return;
      }
      lastError = error;
    } catch (error) {
      lastError = error;
    }

    __logger.error("Redis pipeline command failed", {
      module: "crawl-redis",
      method: "addCrawlJobDone",
      crawlId: id,
      jobId: job_id,
      attempt,
      error: lastError,
    });

    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }

  throw new Error("Failed to mark crawl job as done after retries", {
    cause: lastError,
  });
}

const CRAWL_JOB_DONE_REPAIR_KEY = "crawl-job-done-repair";
const CRAWL_JOB_DONE_REPAIR_BATCH = 100;
const CRAWL_JOB_DONE_REPAIR_MAX = 10000;

type CrawlJobDoneRepairEntry = {
  id: string;
  job_id: string;
  success: boolean;
  at: number;
};

/// Best-effort durable record of a crawl completion marker that could not
/// be written even after retries. Without it, an exhausted addCrawlJobDone
/// leaves the crawl's done-set permanently short and the crawl never
/// completes. Drained by repairCrawlJobDoneMarkers, which the NuQ
/// reconciler worker runs every tick. Never throws.
export async function queueCrawlJobDoneRepair(
  id: string,
  job_id: string,
  success: boolean,
  __logger: Logger = _logger,
) {
  const entry: CrawlJobDoneRepairEntry = {
    id,
    job_id,
    success,
    at: Date.now(),
  };
  // The repair store is a hash keyed by crawl+job, so the write is
  // idempotent and retries can never duplicate an entry or displace
  // another crawl's marker.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await redisEvictConnection.hset(
        CRAWL_JOB_DONE_REPAIR_KEY,
        id + ":" + job_id,
        JSON.stringify(entry),
      );
      return;
    } catch (error) {
      __logger.error("Redis pipeline command failed", {
        module: "crawl-redis",
        method: "queueCrawlJobDoneRepair",
        crawlId: id,
        jobId: job_id,
        attempt,
        error,
      });

      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  }
  // If we get here, Redis is having a sustained outage and nothing local
  // can make the marker recoverable — the canonical logs above are the
  // signal.
}

/// Re-attempts queued crawl completion markers, removing each from the
/// repair hash once it lands. Entries that keep failing stay queued for
/// the next tick. Reads are bounded (HSCAN, not HGETALL) because the hash
/// can accumulate while repairs keep failing, and the scan cursor persists
/// across ticks so a failing early batch cannot starve later entries —
/// every entry is retried once per full scan cycle.
let repairScanCursor = "0";

export async function repairCrawlJobDoneMarkers(__logger: Logger = _logger) {
  const [nextCursor, fields] = await redisEvictConnection.hscan(
    CRAWL_JOB_DONE_REPAIR_KEY,
    repairScanCursor,
    "COUNT",
    CRAWL_JOB_DONE_REPAIR_BATCH,
  );
  // HSCAN returns "0" when the iteration has wrapped; the next tick then
  // starts a fresh cycle and retries the entries that failed this one.
  repairScanCursor = nextCursor;

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const field = fields[i];
    let parsed: CrawlJobDoneRepairEntry;
    try {
      parsed = JSON.parse(fields[i + 1]);
    } catch {
      await redisEvictConnection.hdel(CRAWL_JOB_DONE_REPAIR_KEY, field);
      continue;
    }

    try {
      await addCrawlJobDone(parsed.id, parsed.job_id, parsed.success, __logger);
      await redisEvictConnection.hdel(CRAWL_JOB_DONE_REPAIR_KEY, field);
    } catch {
      // Still failing — leave the entry queued for the next tick.
    }
  }

  // The backlog bound: a hash over this size means repairs have been
  // failing for a long time and the crawl-completion pipeline needs
  // attention, not silent accumulation.
  const backlog = await redisEvictConnection.hlen(CRAWL_JOB_DONE_REPAIR_KEY);
  if (backlog > CRAWL_JOB_DONE_REPAIR_MAX) {
    __logger.error("Redis pipeline command failed", {
      module: "crawl-redis",
      method: "repairCrawlJobDoneMarkers",
      backlog,
      error: new Error(
        "Crawl completion repair backlog exceeds " +
          CRAWL_JOB_DONE_REPAIR_MAX +
          " entries",
      ),
    });
  }
}

export async function getDoneJobsOrderedLength(
  id: string,
  until: number = Infinity,
): Promise<number> {
  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_donez_ordered",
    24 * 60 * 60,
  );
  return await redisEvictConnection.zcount(
    "crawl:" + id + ":jobs_donez_ordered",
    -Infinity,
    until,
  );
}

export async function getDoneJobsOrdered(
  id: string,
  start = 0,
  end = -1,
): Promise<string[]> {
  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_donez_ordered",
    24 * 60 * 60,
  );
  return await redisEvictConnection.zrange(
    "crawl:" + id + ":jobs_donez_ordered",
    start,
    end,
  );
}

export async function getLastDoneJobTimestamp(
  id: string,
): Promise<number | null> {
  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_donez_ordered",
    24 * 60 * 60,
  );
  const result = await redisEvictConnection.zrange(
    "crawl:" + id + ":jobs_donez_ordered",
    -1,
    -1,
    "WITHSCORES",
  );
  if (!result || result.length < 2) return null;
  const score = parseInt(result[1], 10);
  return Number.isFinite(score) ? score : null;
}

export async function getDoneJobsOrderedUntil(
  id: string,
  until: number = Infinity,
  start = 0,
  count = -1,
): Promise<string[]> {
  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_donez_ordered",
    24 * 60 * 60,
  );
  return await redisEvictConnection.zrangebyscore(
    "crawl:" + id + ":jobs_donez_ordered",
    -Infinity,
    until,
    "LIMIT",
    start,
    count,
  );
}

async function isCrawlFinished(id: string) {
  await redisEvictConnection.expire(
    "crawl:" + id + ":kickoff:finish",
    24 * 60 * 60,
  );
  return (
    (await redisEvictConnection.scard("crawl:" + id + ":jobs_done")) ===
      (await redisEvictConnection.scard("crawl:" + id + ":jobs")) &&
    (await isCrawlKickoffFinished(id))
  );
}

export async function isCrawlKickoffFinished(id: string) {
  await redisEvictConnection.expire(
    "crawl:" + id + ":kickoff:finish",
    24 * 60 * 60,
  );
  return (
    (await redisEvictConnection.get("crawl:" + id + ":kickoff:finish")) !==
      null &&
    (await redisEvictConnection.scard("crawl:" + id + ":sitemap_jobs_done")) ===
      (await redisEvictConnection.scard("crawl:" + id + ":sitemap_jobs"))
  );
}

export async function finishCrawlKickoff(id: string) {
  await redisEvictConnection.set(
    "crawl:" + id + ":kickoff:finish",
    "yes",
    "EX",
    24 * 60 * 60,
  );
}

export async function setCrawlError(id: string, error: string) {
  await redisEvictConnection.set(
    "crawl:" + id + ":error",
    error,
    "EX",
    24 * 60 * 60,
  );
}

export async function getCrawlError(id: string): Promise<string | null> {
  return await redisEvictConnection.get("crawl:" + id + ":error");
}

export async function finishCrawl(id: string, __logger: Logger = _logger) {
  __logger.debug("Marking crawl as finished.", {
    module: "crawl-redis",
    method: "finishCrawl",
    crawlId: id,
  });

  await redisEvictConnection.set(
    "crawl:" + id + ":finish",
    "yes",
    "EX",
    24 * 60 * 60,
  );

  await redisEvictConnection.srem("active_crawls", id);

  const crawl = await getCrawl(id);
  if (crawl && crawl.team_id) {
    await redisEvictConnection.srem("crawls_by_team_id:" + crawl.team_id, id);
    await redisEvictConnection.expire(
      "crawls_by_team_id:" + crawl.team_id,
      24 * 60 * 60,
    );
  }

  // Clear visited sets to save memory
  await redisEvictConnection.del("crawl:" + id + ":visited");
  await redisEvictConnection.del("crawl:" + id + ":visited_unique");

  // Eagerly drop the threat-protection bookkeeping (URL -> decision records
  // of silently skipped discoveries) instead of letting it ride out its 24h
  // TTL. Nothing reads it after the crawl finishes, and deleting it
  // unconditionally keeps the ZDR guarantee even when the crawl document is
  // missing or unreadable at finish time.
  await redisEvictConnection.del("crawl:" + id + ":threat_blocked");
}

export async function getCrawlJobs(id: string): Promise<string[]> {
  return await redisEvictConnection.smembers("crawl:" + id + ":jobs");
}

export async function getCrawlQualifiedJobCount(id: string): Promise<number> {
  return await redisEvictConnection.scard("crawl:" + id + ":jobs_qualified");
}

export function normalizeURL(url: string, sc: StoredCrawl): string {
  const urlO = new URL(url);
  if (sc && sc.crawlerOptions && sc.crawlerOptions.ignoreQueryParameters) {
    urlO.search = "";
  }
  // allow hash-based routes
  if (
    !urlO.hash ||
    urlO.hash.length <= 2 ||
    (!urlO.hash.startsWith("#/") && !urlO.hash.startsWith("#!/"))
  ) {
    urlO.hash = "";
  }
  return urlO.href;
}

// For this function and the infrastructure surrounding it to work correctly, this function must:
// 1. Return the a non-zero number of permutations for all valid URLs.
//    generateURLPermutations(url).length > 0
// 2. The generated permutations of the returned array's members must be the same as the original generated permutations.
//    generateURLPermutations(url) == generateURLPermutations(generateURLPermutations(url)[n])
//    Obviously this is not valid in JS, but you get the idea.
// 3. Two generated permutations of signficantly different URLs may not have any overlap.
//    In practice, this means that if there is a generated array of permutations, there must be no URL that is
//     1. not included in that array, and
//     2. has a permutation that is included in that array.
//
// Points 1 and 2 are proven in permu-refactor.test.ts, point 3 is not as proving a negative is hard and outside the scope of a web crawler.
// - mogery
export function generateURLPermutations(url: string | URL): URL[] {
  const urlO = new URL(url);

  // Construct two versions, one with www., one without
  const urlWithWWW = new URL(urlO);
  const urlWithoutWWW = new URL(urlO);
  if (urlO.hostname.startsWith("www.")) {
    urlWithoutWWW.hostname = urlWithWWW.hostname.slice(4);
  } else {
    urlWithWWW.hostname = "www." + urlWithoutWWW.hostname;
  }

  let permutations = [urlWithWWW, urlWithoutWWW];

  // Construct more versions for http/https
  permutations = permutations.flatMap(urlO => {
    if (!["http:", "https:"].includes(urlO.protocol)) {
      return [urlO];
    }

    const urlWithHTTP = new URL(urlO);
    const urlWithHTTPS = new URL(urlO);
    urlWithHTTP.protocol = "http:";
    urlWithHTTPS.protocol = "https:";

    return [urlWithHTTP, urlWithHTTPS];
  });

  // Construct more versions for index.html/index.php
  permutations = permutations.flatMap(urlO => {
    const urlWithHTML = new URL(urlO);
    const urlWithPHP = new URL(urlO);
    const urlWithBare = new URL(urlO);
    const urlWithSlash = new URL(urlO);

    if (urlO.pathname.endsWith("/")) {
      urlWithBare.pathname =
        urlWithBare.pathname.length === 1
          ? urlWithBare.pathname
          : urlWithBare.pathname.slice(0, -1);
      urlWithHTML.pathname += "index.html";
      urlWithPHP.pathname += "index.php";
    } else if (urlO.pathname.endsWith("/index.html")) {
      urlWithPHP.pathname =
        urlWithPHP.pathname.slice(0, -"index.html".length) + "index.php";
      urlWithSlash.pathname = urlWithSlash.pathname.slice(
        0,
        -"index.html".length,
      );
      urlWithBare.pathname = urlWithBare.pathname.slice(
        0,
        -"/index.html".length,
      );
    } else if (urlO.pathname.endsWith("/index.php")) {
      urlWithHTML.pathname =
        urlWithHTML.pathname.slice(0, -"index.php".length) + "index.html";
      urlWithSlash.pathname = urlWithSlash.pathname.slice(
        0,
        -"index.php".length,
      );
      urlWithBare.pathname = urlWithBare.pathname.slice(
        0,
        -"/index.php".length,
      );
    } else {
      urlWithSlash.pathname += "/";
      urlWithHTML.pathname += "/index.html";
      urlWithPHP.pathname += "/index.php";
    }

    return [urlWithHTML, urlWithPHP, urlWithSlash, urlWithBare];
  });

  return [...new Set(permutations.map(x => x.href))].map(x => new URL(x));
}

export async function lockURL(
  id: string,
  sc: StoredCrawl,
  url: string,
  __logger: Logger = _logger,
): Promise<boolean> {
  return await withSpan("firecrawl-redis-lock-url", async span => {
    const normalizedUrl = normalizeURL(url, sc);
    setSpanAttributes(span, {
      "crawl.id": id,
      "crawl.url": normalizedUrl,
      "crawl.team_id": sc.team_id,
      operation: "lock_url",
    });

    if (typeof sc.crawlerOptions?.limit === "number") {
      if (
        (await redisEvictConnection.scard("crawl:" + id + ":visited_unique")) >=
        sc.crawlerOptions.limit
      ) {
        setSpanAttributes(span, { "crawl.limit_reached": true });
        return false;
      }
    }

    const lockTarget = !sc.crawlerOptions?.deduplicateSimilarURLs
      ? normalizedUrl
      : generateURLPermutations(normalizedUrl)[0].href;

    // The commands are idempotent, so retry the pipeline on failure: the
    // SADD may land before a failing command (e.g. a failed EXPIRE), and
    // giving up then would leave the URL marked visited without being
    // queued — a caller retry would read SADD=0 and skip it. Track whether
    // any attempt reported the SADD as newly added, since a retry after a
    // partial success reads 0.
    let sawNewLock = false;
    let locked = false;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let attemptError: unknown = null;
      try {
        const pipeline = redisEvictConnection.pipeline();
        pipeline.sadd("crawl:" + id + ":visited", lockTarget);
        pipeline.expire("crawl:" + id + ":visited", 24 * 60 * 60);
        const attemptResults = await pipeline.exec();
        if (attemptResults?.[0]?.[1] === 1) {
          sawNewLock = true;
        }
        attemptError = firstPipelineError(attemptResults);
      } catch (error) {
        attemptError = error;
      }

      if (attemptError === null) {
        locked = true;
        lastError = null;
        break;
      }
      lastError = attemptError;

      __logger.error("Redis pipeline command failed", {
        module: "crawl-redis",
        method: "lockURL",
        crawlId: id,
        url: normalizedUrl,
        attempt,
        error: attemptError,
      });

      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }

    if (!locked) {
      throw new Error("URL lock pipeline failed after retries", {
        cause: lastError,
      });
    }

    const res = sawNewLock;

    if (res) {
      // The visited SADD has already landed, so a caller retry would skip
      // this URL as already-visited and it would be lost from the crawl.
      // The visited_unique bookkeeping is idempotent — retry it before
      // exposing the failure.
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        let attemptError: unknown = null;
        try {
          const uniquePipeline = redisEvictConnection.pipeline();
          uniquePipeline.sadd("crawl:" + id + ":visited_unique", normalizedUrl);
          uniquePipeline.expire(
            "crawl:" + id + ":visited_unique",
            24 * 60 * 60,
          );
          attemptError = firstPipelineError(await uniquePipeline.exec());
        } catch (error) {
          attemptError = error;
        }

        if (attemptError === null) {
          lastError = null;
          break;
        }
        lastError = attemptError;

        __logger.error("Redis pipeline command failed", {
          module: "crawl-redis",
          method: "lockURL",
          crawlId: id,
          url: normalizedUrl,
          attempt,
          error: attemptError,
        });

        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
        }
      }

      if (lastError !== null) {
        // Roll back the locks we just acquired, so a caller retry can
        // re-lock and queue this URL instead of skipping it as
        // already-visited. visited_unique may have landed during a retried
        // attempt whose EXPIRE failed, so remove it too — otherwise the
        // stale member consumes crawl-limit budget for a URL that was
        // never queued. The rollback itself is retried; if it still fails,
        // Redis is having a sustained outage and the canonical logs are
        // the signal.
        for (let attempt = 1; attempt <= 3; attempt++) {
          let rollbackError: unknown = null;
          try {
            const rollback = redisEvictConnection.pipeline();
            rollback.srem("crawl:" + id + ":visited", lockTarget);
            rollback.srem("crawl:" + id + ":visited_unique", normalizedUrl);
            rollbackError = firstPipelineError(await rollback.exec());
          } catch (error) {
            rollbackError = error;
          }

          if (rollbackError === null) {
            break;
          }

          __logger.error("Redis pipeline command failed", {
            module: "crawl-redis",
            method: "lockURL",
            crawlId: id,
            url: normalizedUrl,
            attempt,
            error: rollbackError,
          });

          if (attempt < 3) {
            await new Promise(resolve =>
              setTimeout(resolve, 50 * 2 ** attempt),
            );
          }
        }
        throw new Error("Unique URL lock pipeline failed after retries", {
          cause: lastError,
        });
      }
    }

    setSpanAttributes(span, { "crawl.url_locked": res });
    return res;
  });
}

/// NOTE: does not check limit. only use if limit is checked beforehand e.g. with sitemap
export async function lockURLs(
  id: string,
  sc: StoredCrawl,
  urls: string[],
  __logger: Logger = _logger,
): Promise<boolean> {
  if (urls.length === 0) return true;

  urls = urls.map(url => normalizeURL(url, sc));
  const logger = __logger.child({
    crawlId: id,
    module: "crawl-redis",
    method: "lockURLs",
    teamId: sc.team_id,
  });

  // Add to visited_unique set
  logger.debug("Locking " + urls.length + " URLs...");

  const visitedUrls = !sc.crawlerOptions?.deduplicateSimilarURLs
    ? urls
    : urls.map(url => generateURLPermutations(url)[0].href);
  if (sc.crawlerOptions?.deduplicateSimilarURLs) {
    logger.debug("Adding URL permutations...", { count: visitedUrls.length });
  }

  // The commands are idempotent, so retry the pipeline on failure: an
  // early chunk may land before a later one fails, and giving up then
  // leaves those URLs marked visited without being queued — a caller retry
  // would read them as already locked and skip them.
  let results: [Error | null, unknown][] | null = null;
  let visitedChunkStartIndexes: number[] = [];
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let attemptError: unknown = null;
    try {
      const pipeline = redisEvictConnection.pipeline();
      for (let i = 0; i < urls.length; i += REDIS_COMMAND_ARG_CHUNK_SIZE) {
        pipeline.sadd(
          "crawl:" + id + ":visited_unique",
          ...urls.slice(i, i + REDIS_COMMAND_ARG_CHUNK_SIZE),
        );
      }
      pipeline.expire("crawl:" + id + ":visited_unique", 24 * 60 * 60);

      visitedChunkStartIndexes = [];
      for (
        let i = 0;
        i < visitedUrls.length;
        i += REDIS_COMMAND_ARG_CHUNK_SIZE
      ) {
        visitedChunkStartIndexes.push(pipeline.length);
        pipeline.sadd(
          "crawl:" + id + ":visited",
          ...visitedUrls.slice(i, i + REDIS_COMMAND_ARG_CHUNK_SIZE),
        );
      }

      pipeline.expire("crawl:" + id + ":visited", 24 * 60 * 60);

      const attemptResults = await pipeline.exec();
      attemptError = firstPipelineError(attemptResults);
      if (attemptError === null) {
        results = attemptResults;
      }
    } catch (error) {
      attemptError = error;
    }

    if (attemptError === null) {
      lastError = null;
      break;
    }
    lastError = attemptError;

    logger.error("Redis pipeline command failed", {
      urlCount: urls.length,
      attempt,
      error: attemptError,
    });

    if (attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }

  if (results === null) {
    throw new Error("Failed to lock URLs after retries", {
      cause: lastError,
    });
  }

  // If an earlier attempt partially landed, the clean attempt's SADD counts
  // under-report (members already present), so res can be false even though
  // every URL is locked. Callers only use this for logging.
  const saddResult = visitedChunkStartIndexes.reduce(
    (total, index) => total + ((results?.[index]?.[1] as number) ?? 0),
    0,
  );
  const res = saddResult === urls.length;

  logger.debug("lockURLs final result", { res });
  return res;
}

export async function lockURLsIndividually(
  id: string,
  sc: StoredCrawl,
  jobs: { id: string; url: string }[],
) {
  const out: typeof jobs = [];

  for (const job of jobs) {
    if (await lockURL(id, sc, job.url)) {
      out.push(job);
    }
  }

  return out;
}

export function crawlToCrawler(
  id: string,
  sc: StoredCrawl,
  teamFlags: TeamFlags,
  newBase?: string,
  crawlerOptions?: any,
): WebCrawler {
  const crawler = new WebCrawler({
    jobId: id,
    initialUrl: sc.originUrl!,
    baseUrl: newBase ? new URL(newBase).origin : undefined,
    includes: (sc.crawlerOptions?.includes ?? []).filter(
      x => x.trim().length > 0,
    ),
    excludes: (sc.crawlerOptions?.excludes ?? []).filter(
      x => x.trim().length > 0,
    ),
    maxCrawledLinks: sc.crawlerOptions?.maxCrawledLinks ?? 1000,
    maxCrawledDepth: getAdjustedMaxDepth(
      sc.originUrl!,
      sc.crawlerOptions?.maxDepth ?? 10,
    ),
    limit: sc.crawlerOptions?.limit ?? 10000,
    generateImgAltText: sc.crawlerOptions?.generateImgAltText ?? false,
    allowBackwardCrawling: sc.crawlerOptions?.allowBackwardCrawling ?? false,
    allowExternalContentLinks:
      sc.crawlerOptions?.allowExternalContentLinks ?? false,
    allowSubdomains: sc.crawlerOptions?.allowSubdomains ?? false,
    ignoreRobotsTxt:
      getIgnoreRobots(teamFlags) === "forced" ||
      (getIgnoreRobots(teamFlags) === "allowed" &&
        (sc.crawlerOptions?.ignoreRobotsTxt ?? false)),
    regexOnFullURL: sc.crawlerOptions?.regexOnFullURL ?? false,
    maxDiscoveryDepth: sc.crawlerOptions?.maxDiscoveryDepth,
    currentDiscoveryDepth: crawlerOptions?.currentDiscoveryDepth ?? 0,
    zeroDataRetention:
      (getScrapeZDR(teamFlags) === "forced" || sc.zeroDataRetention) ?? false,
    location: sc.scrapeOptions?.location,
    headers: sc.scrapeOptions?.headers,
    robotsUserAgent: sc.crawlerOptions?.robotsUserAgent,
  });

  if (sc.robots !== undefined) {
    try {
      crawler.importRobotsTxt(sc.robots);
    } catch (_) {}
  }

  return crawler;
}
