import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger as _logger } from "../lib/logger";
import { configDotenv } from "dotenv";
import { ApiError } from "@google-cloud/storage";
import crypto from "crypto";
import { redisEvictConnection } from "./redis";
import type { Logger } from "winston";
import psl from "psl";
import { MapDocument } from "../controllers/v2/types";
import { PdfMetadata } from "@mendable/firecrawl-rs";
import { storage } from "../lib/gcs-jobs";
import { withSpan, setSpanAttributes } from "../lib/otel-tracer";
configDotenv();

// SupabaseService class initializes the Supabase client conditionally based on environment variables.
class IndexSupabaseService {
  private client: SupabaseClient | null = null;

  constructor() {
    const supabaseUrl = process.env.INDEX_SUPABASE_URL;
    const supabaseServiceToken = process.env.INDEX_SUPABASE_SERVICE_TOKEN;
    // Only initialize the Supabase client if both URL and Service Token are provided.
    if (!supabaseUrl || !supabaseServiceToken) {
      // Warn the user that Authentication is disabled by setting the client to null
      _logger.warn("Index supabase client will not be initialized.");
      this.client = null;
    } else {
      this.client = createClient(supabaseUrl, supabaseServiceToken);
    }
  }

  // Provides access to the initialized Supabase client, if available.
  getClient(): SupabaseClient | null {
    return this.client;
  }
}

const serv = new IndexSupabaseService();

// Using a Proxy to handle dynamic access to the Supabase client or service methods.
// This approach ensures that if Supabase is not configured, any attempt to use it will result in a clear error.
export const index_supabase_service: SupabaseClient = new Proxy(serv, {
  get: function (target, prop, receiver) {
    const client = target.getClient();
    // If the Supabase client is not initialized, intercept property access to provide meaningful error feedback.
    if (client === null) {
      return () => {
        throw new Error("Index supabase client is not configured.");
      };
    }
    // Direct access to SupabaseService properties takes precedence.
    if (prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    // Otherwise, delegate access to the Supabase client.
    return Reflect.get(client, prop, receiver);
  },
}) as unknown as SupabaseClient;

const credentials = process.env.GCS_CREDENTIALS
  ? JSON.parse(atob(process.env.GCS_CREDENTIALS))
  : undefined;

export async function getIndexFromGCS(
  url: string,
  logger?: Logger,
): Promise<any | null> {
  try {
    return await withSpan("firecrawl-index-get-from-gcs", async span => {
      setSpanAttributes(span, {
        "index.operation": "get_from_gcs",
        "index.url": url,
      });

      if (!process.env.GCS_INDEX_BUCKET_NAME) {
        setSpanAttributes(span, { "gcs.index_bucket_configured": false });
        return null;
      }

      const bucket = storage.bucket(process.env.GCS_INDEX_BUCKET_NAME);
      const blob = bucket.file(`${url}`);
      const [blobContent] = await blob.download();
      const parsed = JSON.parse(blobContent.toString());

      try {
        if (typeof parsed.screenshot === "string") {
          const screenshotUrl = new URL(parsed.screenshot);
          let expiresAt =
            parseInt(screenshotUrl.searchParams.get("Expires") ?? "0", 10) *
            1000;
          if (expiresAt === 0) {
            expiresAt =
              new Date(
                screenshotUrl.searchParams.get("X-Goog-Date") ??
                  "1970-01-01T00:00:00Z",
              ).getTime() +
              parseInt(
                screenshotUrl.searchParams.get("X-Goog-Expires") ?? "0",
                10,
              ) *
                1000;
          }
          if (
            screenshotUrl.hostname === "storage.googleapis.com" &&
            expiresAt < Date.now()
          ) {
            logger?.info("Re-signing screenshot URL");
            const [url] = await storage
              .bucket(process.env.GCS_MEDIA_BUCKET_NAME!)
              .file(decodeURIComponent(screenshotUrl.pathname.split("/")[2]))
              .getSignedUrl({
                action: "read",
                expires: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
              });
            parsed.screenshot = url;

            // Update the blob
            await blob.save(JSON.stringify(parsed), {
              contentType: "application/json",
            });
          }
        }
      } catch (error) {
        logger?.warn("Error re-signing screenshot URL", {
          error,
          url,
        });
      }

      setSpanAttributes(span, { "index.document_found": true });
      return parsed;
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === 404 &&
      error.message.includes("No such object:")
    ) {
      return null;
    }

    (logger ?? _logger).error(`Error getting Index document from GCS`, {
      error,
      url,
    });
    return null;
  }
}

export async function saveIndexToGCS(
  id: string,
  doc: {
    url: string;
    html: string;
    statusCode: number;
    error?: string;
    screenshot?: string;
    pdfMetadata?: PdfMetadata;
    contentType?: string;
    postprocessorsUsed?: string[];
  },
): Promise<void> {
  return await withSpan("firecrawl-index-save-to-gcs", async span => {
    setSpanAttributes(span, {
      "index.operation": "save_to_gcs",
      "index.id": id,
      "index.url": doc.url,
      "index.status_code": doc.statusCode,
      "index.has_error": !!doc.error,
    });

    if (!process.env.GCS_INDEX_BUCKET_NAME) {
      setSpanAttributes(span, { "gcs.index_bucket_configured": false });
      return;
    }

    const bucket = storage.bucket(process.env.GCS_INDEX_BUCKET_NAME);
    const blob = bucket.file(`${id}.json`);

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify(doc), {
          contentType: "application/json",
        });
        setSpanAttributes(span, { "index.save_successful": true });
        break;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          _logger.error(`Error saving index document to GCS, retrying`, {
            error,
            indexId: id,
            i,
          });
        }
      }
    }
  });
}

export const useIndex =
  process.env.INDEX_SUPABASE_URL !== "" &&
  process.env.INDEX_SUPABASE_URL !== undefined;

export const useSearchIndex =
  process.env.SEARCH_INDEX_SUPABASE_URL !== "" &&
  process.env.SEARCH_INDEX_SUPABASE_URL !== undefined;

export function normalizeURLForIndex(url: string): string {
  const urlObj = new URL(url);
  urlObj.hash = "";
  urlObj.protocol = "https";

  if (urlObj.port === "80" || urlObj.port === "443") {
    urlObj.port = "";
  }

  if (urlObj.hostname.startsWith("www.")) {
    urlObj.hostname = urlObj.hostname.slice(4);
  }

  if (urlObj.pathname.endsWith("/index.html")) {
    urlObj.pathname = urlObj.pathname.slice(0, -10);
  } else if (urlObj.pathname.endsWith("/index.php")) {
    urlObj.pathname = urlObj.pathname.slice(0, -9);
  } else if (urlObj.pathname.endsWith("/index.htm")) {
    urlObj.pathname = urlObj.pathname.slice(0, -9);
  } else if (urlObj.pathname.endsWith("/index.shtml")) {
    urlObj.pathname = urlObj.pathname.slice(0, -11);
  } else if (urlObj.pathname.endsWith("/index.xml")) {
    urlObj.pathname = urlObj.pathname.slice(0, -9);
  }

  if (urlObj.pathname.endsWith("/")) {
    urlObj.pathname = urlObj.pathname.slice(0, -1);
  }

  return urlObj.toString();
}

export function hashURL(url: string): string {
  return "\\x" + crypto.createHash("sha256").update(url).digest("hex");
}

export function generateURLSplits(url: string): string[] {
  const urls: string[] = [];
  const urlObj = new URL(url);
  urlObj.hash = "";
  urlObj.search = "";
  const pathnameParts = urlObj.pathname.split("/");

  for (let i = 0; i <= pathnameParts.length; i++) {
    urlObj.pathname = pathnameParts.slice(0, i).join("/");
    urls.push(urlObj.href);
  }

  urls.push(url);

  return [...new Set(urls.map(x => normalizeURLForIndex(x)))];
}

export function generateDomainSplits(
  hostname: string,
  fakeDomain?: string,
): string[] {
  if (fakeDomain) {
    const parsed = psl.parse(hostname);
    if (parsed === null) return [fakeDomain];

    const fakeParsed = psl.parse(fakeDomain);
    if (fakeParsed === null || fakeParsed.domain === null) return [fakeDomain];

    const subdomains: string[] = (fakeParsed.subdomain ?? "")
      .split(".")
      .filter(x => x !== "");
    if (subdomains.length === 1 && subdomains[0] === "www") {
      return [fakeParsed.domain];
    }

    const domains: string[] = [];
    for (let i = subdomains.length; i >= 0; i--) {
      domains.push(subdomains.slice(i).concat([fakeParsed.domain]).join("."));
    }

    return domains;
  }

  const parsed = psl.parse(hostname);
  if (parsed === null) {
    return [];
  }

  const subdomains: string[] = (parsed.subdomain ?? "")
    .split(".")
    .filter(x => x !== "");
  if (subdomains.length === 1 && subdomains[0] === "www") {
    return [parsed.domain];
  }

  const domains: string[] = [];
  for (let i = subdomains.length; i >= 0; i--) {
    domains.push(subdomains.slice(i).concat([parsed.domain]).join("."));
  }

  return domains;
}

const INDEX_INSERT_QUEUE_KEY = "index-insert-queue";
const INDEX_INSERT_BATCH_SIZE = 100;

export async function addIndexInsertJob(data: any) {
  await redisEvictConnection.rpush(
    INDEX_INSERT_QUEUE_KEY,
    JSON.stringify(data),
  );
}

async function getIndexInsertJobs(): Promise<any[]> {
  const jobs =
    (await redisEvictConnection.lpop(
      INDEX_INSERT_QUEUE_KEY,
      INDEX_INSERT_BATCH_SIZE,
    )) ?? [];
  return jobs.map(x => JSON.parse(x));
}

export async function processIndexInsertJobs() {
  const jobs = await getIndexInsertJobs();
  if (jobs.length === 0) {
    return;
  }
  _logger.info(`Index inserter found jobs to insert`, {
    jobCount: jobs.length,
  });
  try {
    const { error } = await index_supabase_service.from("index").insert(jobs);
    if (error) {
      _logger.error(`Index inserter failed to insert jobs`, {
        error,
        jobCount: jobs.length,
      });
    }
    _logger.info(`Index inserter inserted jobs`, { jobCount: jobs.length });
  } catch (error) {
    _logger.error(`Index inserter failed to insert jobs`, {
      error,
      jobCount: jobs.length,
    });
  }
}

export async function getIndexInsertQueueLength(): Promise<number> {
  return (await redisEvictConnection.llen(INDEX_INSERT_QUEUE_KEY)) ?? 0;
}

const INDEX_RF_INSERT_QUEUE_KEY = "index-rf-insert-queue";
const INDEX_RF_INSERT_BATCH_SIZE = 100;

export async function addIndexRFInsertJob(data: any) {
  await redisEvictConnection.rpush(
    INDEX_RF_INSERT_QUEUE_KEY,
    JSON.stringify(data),
  );
}

async function getIndexRFInsertJobs(): Promise<any[]> {
  const jobs =
    (await redisEvictConnection.lpop(
      INDEX_RF_INSERT_QUEUE_KEY,
      INDEX_RF_INSERT_BATCH_SIZE,
    )) ?? [];
  return jobs.map(x => JSON.parse(x));
}

export async function processIndexRFInsertJobs() {
  const jobs = await getIndexRFInsertJobs();
  if (jobs.length === 0) {
    return;
  }
  _logger.info(`Index RF inserter found jobs to insert`, {
    jobCount: jobs.length,
  });
  try {
    const { error } = await index_supabase_service
      .from("request_frequency")
      .insert(jobs);
    if (error) {
      _logger.error(`Index RF inserter failed to insert jobs`, {
        error,
        jobCount: jobs.length,
      });
    }
    _logger.info(`Index RF inserter inserted jobs`, { jobCount: jobs.length });
  } catch (error) {
    _logger.error(`Index RF inserter failed to insert jobs`, {
      error,
      jobCount: jobs.length,
    });
  }
}

export async function getIndexRFInsertQueueLength(): Promise<number> {
  return (await redisEvictConnection.llen(INDEX_RF_INSERT_QUEUE_KEY)) ?? 0;
}

const OMCE_JOB_QUEUE_KEY = "omce-job-queue";
const OMCE_JOB_QUEUE_BATCH_SIZE = 100;

export async function addOMCEJob(data: [number, string]) {
  await redisEvictConnection.sadd(OMCE_JOB_QUEUE_KEY, JSON.stringify(data));
}

async function getOMCEJobs(): Promise<[number, string][]> {
  const jobs =
    (await redisEvictConnection.spop(
      OMCE_JOB_QUEUE_KEY,
      OMCE_JOB_QUEUE_BATCH_SIZE,
    )) ?? [];
  return jobs.map(x => JSON.parse(x) as [number, string]);
}

export async function processOMCEJobs() {
  const jobs = await getOMCEJobs();
  if (jobs.length === 0) {
    return;
  }
  _logger.info(`OMCE job inserter found jobs to insert`, {
    jobCount: jobs.length,
  });
  try {
    for (const job of jobs) {
      const [level, hash] = job;
      const { error } = await index_supabase_service.rpc(
        "insert_omce_job_if_needed",
        {
          i_domain_level: level,
          i_domain_hash: hash,
        },
      );

      if (error) {
        _logger.error(`OMCE job inserter failed to insert job`, {
          error,
          job,
          jobCount: jobs.length,
        });
      }
    }
    _logger.info(`OMCE job inserter inserted jobs`, { jobCount: jobs.length });
  } catch (error) {
    _logger.error(`OMCE job inserter failed to insert jobs`, {
      error,
      jobCount: jobs.length,
    });
  }
}

export async function getOMCEQueueLength(): Promise<number> {
  return (await redisEvictConnection.scard(OMCE_JOB_QUEUE_KEY)) ?? 0;
}

// Domain Frequency Tracking
const DOMAIN_FREQUENCY_QUEUE_KEY = "domain-frequency-queue";
const DOMAIN_FREQUENCY_BATCH_SIZE = 100;

function extractDomainFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Remove www. prefix for consistency
    let domain = urlObj.hostname;
    if (domain.startsWith("www.")) {
      domain = domain.slice(4);
    }
    return domain;
  } catch (error) {
    _logger.warn("Failed to extract domain from URL", { url, error });
    return null;
  }
}

export async function addDomainFrequencyJob(url: string) {
  const domain = extractDomainFromUrl(url);
  if (!domain) {
    return;
  }

  await redisEvictConnection.rpush(DOMAIN_FREQUENCY_QUEUE_KEY, domain);
}

async function getDomainFrequencyJobs(): Promise<Map<string, number>> {
  const domains =
    (await redisEvictConnection.lpop(
      DOMAIN_FREQUENCY_QUEUE_KEY,
      DOMAIN_FREQUENCY_BATCH_SIZE,
    )) ?? [];

  // Aggregate domain counts in memory before batch insert
  const domainCounts = new Map<string, number>();
  for (const domain of domains) {
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
  }

  return domainCounts;
}

export async function processDomainFrequencyJobs() {
  if (!useIndex) {
    return;
  }

  const domainCounts = await getDomainFrequencyJobs();
  if (domainCounts.size === 0) {
    return;
  }

  _logger.info(`Domain frequency processor found domains to update`, {
    domainCount: domainCounts.size,
  });

  try {
    // Convert to array format for the stored procedure
    const updates = Array.from(domainCounts.entries()).map(
      ([domain, count]) => ({
        domain,
        count,
      }),
    );

    // Use the upsert function for efficient batch update
    const { error } = await index_supabase_service.rpc(
      "upsert_domain_frequencies",
      {
        domain_updates: updates,
      },
    );

    if (error) {
      _logger.error(`Domain frequency processor failed to update domains`, {
        error,
        domainCount: domainCounts.size,
      });
      // Re-queue the domains on failure
      for (const [domain, count] of domainCounts) {
        for (let i = 0; i < count; i++) {
          await redisEvictConnection.rpush(DOMAIN_FREQUENCY_QUEUE_KEY, domain);
        }
      }
    } else {
      _logger.info(`Domain frequency processor updated domains`, {
        domainCount: domainCounts.size,
      });
    }
  } catch (error) {
    _logger.error(`Domain frequency processor failed to update domains`, {
      error,
      domainCount: domainCounts.size,
    });
    // Re-queue the domains on failure
    for (const [domain, count] of domainCounts) {
      for (let i = 0; i < count; i++) {
        await redisEvictConnection.rpush(DOMAIN_FREQUENCY_QUEUE_KEY, domain);
      }
    }
  }
}

export async function getDomainFrequencyQueueLength(): Promise<number> {
  return (await redisEvictConnection.llen(DOMAIN_FREQUENCY_QUEUE_KEY)) ?? 0;
}

// Domain frequency query utilities
export async function getTopDomains(
  limit: number = 100,
): Promise<Array<{ domain: string; frequency: number; last_updated: string }>> {
  if (!useIndex) {
    return [];
  }

  const { data, error } = await index_supabase_service
    .from("domain_frequency")
    .select("domain, frequency, last_updated")
    .order("frequency", { ascending: false })
    .limit(limit);

  if (error) {
    _logger.error("Failed to get top domains", { error });
    return [];
  }

  return data ?? [];
}

export async function getDomainFrequency(
  domain: string,
): Promise<number | null> {
  if (!useIndex) {
    return null;
  }

  const { data, error } = await index_supabase_service
    .from("domain_frequency")
    .select("frequency")
    .eq("domain", domain)
    .single();

  if (error) {
    if (error.code !== "PGRST116") {
      // Not found error
      _logger.error("Failed to get domain frequency", { error, domain });
    }
    return null;
  }

  return data?.frequency ?? null;
}

export async function getDomainFrequencyStats(): Promise<{
  totalDomains: number;
  totalRequests: number;
  avgRequestsPerDomain: number;
} | null> {
  if (!useIndex) {
    return null;
  }

  const { data, error } = await index_supabase_service
    .from("domain_frequency")
    .select("frequency");

  if (error) {
    _logger.error("Failed to get domain frequency stats", { error });
    return null;
  }

  if (!data || data.length === 0) {
    return {
      totalDomains: 0,
      totalRequests: 0,
      avgRequestsPerDomain: 0,
    };
  }

  const totalRequests = data.reduce((sum, row) => sum + row.frequency, 0);
  const totalDomains = data.length;

  return {
    totalDomains,
    totalRequests,
    avgRequestsPerDomain: Math.round(totalRequests / totalDomains),
  };
}

export async function queryIndexAtSplitLevel(
  url: string,
  limit: number,
  maxAge = 2 * 24 * 60 * 60 * 1000,
): Promise<string[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const urlObj = new URL(url);
  urlObj.search = "";

  const urlSplitsHash = generateURLSplits(urlObj.href).map(x => hashURL(x));

  const level = urlSplitsHash.length - 1;

  let links: Set<string> = new Set();
  let iteration = 0;

  while (true) {
    // Query the index for the next set of links
    const { data: _data, error } = await index_supabase_service
      .rpc("query_index_at_split_level", {
        i_level: level,
        i_url_hash: urlSplitsHash[level],
        i_newer_than: new Date(Date.now() - maxAge).toISOString(),
      })
      .range(iteration * 1000, (iteration + 1) * 1000);

    // If there's an error, return the links we have
    if (error) {
      _logger.warn("Error querying index", { error, url, limit });
      return [...links].slice(0, limit);
    }

    // Add the links to the set
    const data = _data ?? [];
    data.forEach(x => links.add(x.resolved_url));

    // If we have enough links, return them
    if (links.size >= limit) {
      return [...links].slice(0, limit);
    }

    // If we get less than 1000 links from the query, we're done
    if (data.length < 1000) {
      return [...links].slice(0, limit);
    }

    iteration++;
  }
}

export async function queryIndexAtDomainSplitLevel(
  hostname: string,
  limit: number,
  maxAge = 2 * 24 * 60 * 60 * 1000,
): Promise<string[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const domainSplitsHash = generateDomainSplits(hostname).map(x => hashURL(x));

  const level = domainSplitsHash.length - 1;
  if (domainSplitsHash.length === 0) {
    return [];
  }

  let links: Set<string> = new Set();
  let iteration = 0;

  while (true) {
    // Query the index for the next set of links
    const { data: _data, error } = await index_supabase_service
      .rpc("query_index_at_domain_split_level", {
        i_level: level,
        i_domain_hash: domainSplitsHash[level],
        i_newer_than: new Date(Date.now() - maxAge).toISOString(),
      })
      .range(iteration * 1000, (iteration + 1) * 1000);

    // If there's an error, return the links we have
    if (error) {
      _logger.warn("Error querying index", { error, hostname, limit });
      return [...links].slice(0, limit);
    }

    // Add the links to the set
    const data = _data ?? [];
    data.forEach(x => links.add(x.resolved_url));

    // If we have enough links, return them
    if (links.size >= limit) {
      return [...links].slice(0, limit);
    }

    // If we get less than 1000 links from the query, we're done
    if (data.length < 1000) {
      return [...links].slice(0, limit);
    }

    iteration++;
  }
}

export async function queryOMCESignatures(
  hostname: string,
  maxAge = 2 * 24 * 60 * 60 * 1000,
): Promise<string[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const domainSplitsHash = generateDomainSplits(hostname).map(x => hashURL(x));

  const level = domainSplitsHash.length - 1;
  if (domainSplitsHash.length === 0) {
    return [];
  }

  const { data, error } = await index_supabase_service.rpc(
    "query_omce_signatures",
    {
      i_domain_hash: domainSplitsHash[level],
      i_newer_than: new Date(Date.now() - maxAge).toISOString(),
    },
  );

  if (error) {
    _logger.warn("Error querying index (omce)", { error, hostname });
    return [];
  }

  return data?.[0]?.signatures ?? [];
}

export async function queryIndexAtSplitLevelWithMeta(
  url: string,
  limit: number,
): Promise<MapDocument[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const urlObj = new URL(url);
  urlObj.search = "";

  const urlSplitsHash = generateURLSplits(urlObj.href).map(x => hashURL(x));

  const level = urlSplitsHash.length - 1;

  let links: MapDocument[] = [];
  let iteration = 0;

  while (true) {
    // Query the index for the next set of links
    const { data: _data, error } = await index_supabase_service
      .rpc("query_index_at_split_level_with_meta", {
        i_level: level,
        i_url_hash: urlSplitsHash[level],
        i_newer_than: new Date(
          Date.now() - 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .range(iteration * 1000, (iteration + 1) * 1000);

    // If there's an error, return the links we have
    if (error) {
      _logger.warn("Error querying index", { error, url, limit });
      return links.slice(0, limit);
    }

    // Add the links to the set
    const data = _data ?? [];
    data.forEach(x =>
      links.push({
        url: x.resolved_url,
        title: x.title ?? undefined,
        description: x.description ?? undefined,
      }),
    );

    // If we have enough links, return them
    if (links.length >= limit) {
      return links.slice(0, limit);
    }

    // If we get less than 1000 links from the query, we're done
    if (data.length < 1000) {
      return links.slice(0, limit);
    }

    iteration++;
  }
}

export async function queryIndexAtDomainSplitLevelWithMeta(
  hostname: string,
  limit: number,
): Promise<MapDocument[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  const domainSplitsHash = generateDomainSplits(hostname).map(x => hashURL(x));

  const level = domainSplitsHash.length - 1;
  if (domainSplitsHash.length === 0) {
    return [];
  }

  let links: MapDocument[] = [];
  let iteration = 0;

  while (true) {
    // Query the index for the next set of links
    const { data: _data, error } = await index_supabase_service
      .rpc("query_index_at_domain_split_level_with_meta", {
        i_level: level,
        i_domain_hash: domainSplitsHash[level],
        i_newer_than: new Date(
          Date.now() - 2 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .range(iteration * 1000, (iteration + 1) * 1000);

    // If there's an error, return the links we have
    if (error) {
      _logger.warn("Error querying index", { error, hostname, limit });
      return links.slice(0, limit);
    }

    // Add the links to the set
    const data = _data ?? [];
    data.forEach(x =>
      links.push({
        url: x.resolved_url,
        title: x.title ?? undefined,
        description: x.description ?? undefined,
      }),
    );

    // If we have enough links, return them
    if (links.length >= limit) {
      return links.slice(0, limit);
    }

    // If we get less than 1000 links from the query, we're done
    if (data.length < 1000) {
      return links.slice(0, limit);
    }

    iteration++;
  }
}

type DomainPriority = {
  domain_hash: string;
  priority: number;
};

export async function queryDomainsForPrecrawl(
  date: Date,
  minEvents = 20,
  minPriority = 0.5,
  maxDomains = 50,
  logger: Logger = _logger,
): Promise<DomainPriority[]> {
  if (!useIndex || process.env.FIRECRAWL_INDEX_WRITE_ONLY === "true") {
    return [];
  }

  let results: DomainPriority[] = [];
  let iteration = 0;

  while (true) {
    const { data, error } = await index_supabase_service
      .rpc("query_domain_priority", {
        p_min_total: minEvents,
        p_min_priority: minPriority,
        p_lim: maxDomains,
        p_time: date.toISOString(),
      })
      .range(
        iteration * 1000,
        Math.min((iteration + 1) * 1000, maxDomains) - 1,
      );

    if (error) {
      logger.error("Error getting domain priorities", {
        error,
      });
      return results.slice(0, maxDomains);
    }

    const batchData = data ?? [];
    results = results.concat(batchData);

    if (results.length >= maxDomains) {
      return results.slice(0, maxDomains);
    }

    if (batchData.length < 1000) {
      return results.slice(0, maxDomains);
    }

    iteration++;
  }
}
