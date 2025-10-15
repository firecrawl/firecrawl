import { InternalOptions } from "../scraper/scrapeURL";
import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { WebCrawler } from "../scraper/WebScraper/crawler";
import { redisEvictConnection } from "../services/redis";
import { logger as _logger } from "./logger";
import { getAdjustedMaxDepth } from "../scraper/WebScraper/utils/maxDepthUtils";
import type { Logger } from "winston";
import { withSpan, setSpanAttributes } from "./otel-tracer";

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

    await redisEvictConnection.set("crawl:" + id, JSON.stringify(crawl));
    await redisEvictConnection.expire("crawl:" + id, 24 * 60 * 60);

    await redisEvictConnection.sadd("crawls_by_team_id:" + crawl.team_id, id);
    await redisEvictConnection.expire(
      "crawls_by_team_id:" + crawl.team_id,
      24 * 60 * 60,
    );
  });
}

export async function markCrawlActive(id: string) {
  await redisEvictConnection.sadd("active_crawls", id);
}

export async function getCrawlsByTeamId(team_id: string): Promise<string[]> {
  return await redisEvictConnection.smembers("crawls_by_team_id:" + team_id);
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

    await redisEvictConnection.sadd("crawl:" + id + ":jobs", job_id);
    await redisEvictConnection.expire("crawl:" + id + ":jobs", 24 * 60 * 60);
    await redisEvictConnection.sadd("crawl:" + id + ":jobs_qualified", job_id);
    await redisEvictConnection.expire(
      "crawl:" + id + ":jobs_qualified",
      24 * 60 * 60,
    );
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
  await redisEvictConnection.sadd("crawl:" + id + ":jobs", ...job_ids);
  await redisEvictConnection.expire("crawl:" + id + ":jobs", 24 * 60 * 60);
  await redisEvictConnection.sadd(
    "crawl:" + id + ":jobs_qualified",
    ...job_ids,
  );
  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_qualified",
    24 * 60 * 60,
  );
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
  await redisEvictConnection.sadd("crawl:" + id + ":jobs_done", job_id);
  await redisEvictConnection.expire("crawl:" + id + ":jobs_done", 24 * 60 * 60);

  if (success) {
    await redisEvictConnection.zadd(
      "crawl:" + id + ":jobs_donez_ordered",
      Date.now(),
      job_id,
    );
  } else {
    // in case it's already been pushed, make sure it's removed
    await redisEvictConnection.zrem(
      "crawl:" + id + ":jobs_donez_ordered",
      job_id,
    );
  }

  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_donez_ordered",
    24 * 60 * 60,
  );
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

export async function finishCrawlPre(id: string, __logger: Logger = _logger) {
  if (await isCrawlFinished(id)) {
    __logger.debug("Marking crawl as pre-finished.", {
      module: "crawl-redis",
      method: "finishCrawlPre",
      crawlId: id,
    });
    const set = await redisEvictConnection.setnx(
      "crawl:" + id + ":finished_pre",
      "yes",
    );
    await redisEvictConnection.expire(
      "crawl:" + id + ":finished_pre",
      24 * 60 * 60,
    );
    return set === 1;
  }
}

export async function unPreFinishCrawl(id: string) {
  _logger.debug("Un-pre-finishing crawl.", {
    module: "crawl-redis",
    method: "unPreFinishCrawl",
    crawlId: id,
  });
  await redisEvictConnection.del("crawl:" + id + ":finished_pre");
}

export async function finishCrawl(id: string, __logger: Logger = _logger) {
  __logger.debug("Marking crawl as finished.", {
    module: "crawl-redis",
    method: "finishCrawl",
    crawlId: id,
  });
  await redisEvictConnection.set("crawl:" + id + ":finish", "yes");
  await redisEvictConnection.expire("crawl:" + id + ":finish", 24 * 60 * 60);

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
  if (!urlO.hash || urlO.hash.length <= 2 || !urlO.hash.startsWith("#/")) {
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

    let res: boolean;
    if (!sc.crawlerOptions?.deduplicateSimilarURLs) {
      res =
        (await redisEvictConnection.sadd(
          "crawl:" + id + ":visited",
          normalizedUrl,
        )) !== 0;
    } else {
      const permutation = generateURLPermutations(normalizedUrl)[0].href;
      const x = await redisEvictConnection.sadd(
        "crawl:" + id + ":visited",
        permutation,
      );
      res = x !== 0;
    }

    await redisEvictConnection.expire("crawl:" + id + ":visited", 24 * 60 * 60);

    if (res) {
      await redisEvictConnection.sadd(
        "crawl:" + id + ":visited_unique",
        normalizedUrl,
      );
      await redisEvictConnection.expire(
        "crawl:" + id + ":visited_unique",
        24 * 60 * 60,
      );
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
  await redisEvictConnection.sadd("crawl:" + id + ":visited_unique", ...urls);
  await redisEvictConnection.expire(
    "crawl:" + id + ":visited_unique",
    24 * 60 * 60,
  );

  let res: boolean;
  if (!sc.crawlerOptions?.deduplicateSimilarURLs) {
    const x = await redisEvictConnection.sadd(
      "crawl:" + id + ":visited",
      ...urls,
    );
    res = x === urls.length;
  } else {
    const allPermutations = urls.map(
      url => generateURLPermutations(url)[0].href,
    );
    logger.debug("Adding " + allPermutations.length + " URL permutations...");
    const x = await redisEvictConnection.sadd(
      "crawl:" + id + ":visited",
      ...allPermutations,
    );
    res = x === allPermutations.length;
  }

  await redisEvictConnection.expire("crawl:" + id + ":visited", 24 * 60 * 60);

  logger.debug("lockURLs final result: " + res, { res });
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
      teamFlags?.ignoreRobots ?? sc.crawlerOptions?.ignoreRobotsTxt ?? false,
    regexOnFullURL: sc.crawlerOptions?.regexOnFullURL ?? false,
    maxDiscoveryDepth: sc.crawlerOptions?.maxDiscoveryDepth,
    currentDiscoveryDepth: crawlerOptions?.currentDiscoveryDepth ?? 0,
    zeroDataRetention: (teamFlags?.forceZDR || sc.zeroDataRetention) ?? false,
    location: sc.scrapeOptions?.location,
  });

  if (sc.robots !== undefined) {
    try {
      crawler.importRobotsTxt(sc.robots);
    } catch (_) {}
  }

  return crawler;
}
