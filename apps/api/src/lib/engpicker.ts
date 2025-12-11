import { generateObject } from "ai";
import { z } from "zod";
import { scrapeOptions } from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import type { Engine } from "../scraper/scrapeURL/engines";
import { index_supabase_service } from "../services";
import { CostTracking } from "./cost-tracking";
import { getModel } from "./generic-ai";
import { logger as _logger } from "./logger";
import type { Logger } from "winston";
import {
  computeEngpickerVerdict,
  type EngpickerUrlResult,
} from "@mendable/firecrawl-rs";

type EngpickerJob = {
  id: number;
  domain_hash: string;
  domain_level: number;
  picked_up_at: string | null;
  done: boolean;
  created_at: string;
};

async function evaluateURL(
  id: string,
  url: string,
  engine: Engine,
  stealth: boolean,
  logger: Logger,
): Promise<{
  engine: Engine;
  stealth: boolean;
  markdown: string | null;
  result: boolean;
}> {
  const scrapeResult = await scrapeURL(
    id,
    url,
    scrapeOptions.parse({
      proxy: stealth ? "stealth" : "basic",
      maxAge: 0,
      storeInCache: false,
    }),
    {
      forceEngine: engine,
      teamId: "engpicker",
    },
    new CostTracking(),
  );

  if (!scrapeResult.success) {
    logger.warn("Scrape failed", { scrapeResult });
    return {
      engine,
      stealth,
      markdown: null,
      result: false,
    };
  }

  const markdown = scrapeResult.document.markdown ?? "";

  logger.info("Scrape completed, waiting for AI evaluation");

  // Use GPT-4o-mini to evaluate if the scrape was actually successful
  const evaluationResult = await generateObject({
    model: getModel("gpt-4o-mini", "openai"),
    schema: z.object({
      is_successful: z.boolean(),
    }),
    messages: [
      {
        role: "system",
        content: `You are a web scraping quality evaluator. Your job is to determine if a web scrape was successful based on the returned markdown content.

A scrape should be considered UNSUCCESSFUL if the content indicates any of the following:
- Antibot/captcha challenges (e.g., Cloudflare, reCAPTCHA, hCaptcha, bot detection messages)
- Region/geo blocks (e.g., "not available in your region", "access denied from your location")
- HTTP error pages (4xx or 5xx errors like "404 Not Found", "403 Forbidden", "500 Internal Server Error")
- Access denied or authentication required pages
- Rate limiting messages
- Empty or near-empty content that suggests the page didn't load properly

A scrape should be considered SUCCESSFUL if:
- The content appears to be the actual page content with meaningful text
- The page loaded properly with real content visible

A scrape may still be successful if:
- Cookie consent walls block the actual content
- Paywalls block the actual content`,
      },
      {
        role: "user",
        content: `Evaluate if this scraped markdown content represents a successful scrape:\n\n${markdown.slice(0, 4000)}`,
      },
    ],
  });

  const isSuccess = evaluationResult.object.is_successful;

  logger.info("AI evaluation completed", { isSuccess });

  return {
    engine,
    stealth,
    markdown,
    result: isSuccess,
  };
}

export async function processEngpickerJob() {
  let logger = _logger.child({
    module: "engpicker",
    method: "processEngpickerJob",
  });

  const { data: jobData, error: getJobError } = await index_supabase_service
    .from("engpicker_queue")
    .update({
      picked_up_at: new Date().toISOString(),
    })
    .is("picked_up_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .select("*");

  if (getJobError) {
    logger.error("Error picking up engpicker job", { getJobError });
    await new Promise(resolve => setTimeout(resolve, 1000));
    return;
  }

  const job: EngpickerJob | undefined = jobData?.[0] ?? undefined;
  if (!job) {
    logger.debug("No engpicker job to pick up");
    await new Promise(resolve => setTimeout(resolve, 1000));
    return;
  }

  logger = logger.child({
    jobId: job.id,
  });

  logger.info("Picked up engpicker job");

  // main shit here

  const { data: indexRows, error: indexRowsError } =
    await index_supabase_service
      .rpc("query_index_at_domain_split_level_omce", {
        i_level: job.domain_level,
        i_domain_hash: job.domain_hash,
        i_newer_than: new Date(
          new Date(job.created_at).valueOf() - 1000 * 60 * 60 * 24,
        ).toISOString(),
      })
      .limit(100);

  if (indexRowsError || !indexRows) {
    logger.error("Error querying index rows", { indexRowsError });
    await new Promise(resolve => setTimeout(resolve, 1000));
    return;
  }

  // Filter out non-content URLs (sitemaps, feeds, etc.)
  const EXCLUDED_EXTENSIONS = [
    ".xml",
    ".json",
    ".txt",
    ".rss",
    ".atom",
    ".pdf",
    ".zip",
    ".gz",
  ];
  const filteredRows = indexRows.filter((row: { url: string }) => {
    const url = row.url.toLowerCase();
    const pathname = new URL(url).pathname.toLowerCase();
    return !EXCLUDED_EXTENSIONS.some(ext => pathname.endsWith(ext));
  });

  const randomizedURLs: string[] = [];
  for (let i = 0; i < 10; i++) {
    const elem = filteredRows.splice(
      Math.floor(Math.random() * filteredRows.length),
      1,
    );
    if (elem && elem.length > 0) {
      randomizedURLs.push(elem[0].url);
    }
  }

  logger.info("Picked randomized URLs", { randomizedURLs });

  const results = await Promise.all(
    randomizedURLs.map(async url => ({
      url,
      results: await Promise.all([
        evaluateURL(
          job.id + "-cdp-basic",
          url,
          "fire-engine;chrome-cdp",
          false,
          logger.child({
            method: "evaluateURL",
            engine: "fire-engine;chrome-cdp",
            stealth: false,
          }),
        ),
        evaluateURL(
          job.id + "-cdp-stealth",
          url,
          "fire-engine;chrome-cdp;stealth",
          true,
          logger.child({
            method: "evaluateURL",
            engine: "fire-engine;chrome-cdp;stealth",
            stealth: true,
          }),
        ),
        evaluateURL(
          job.id + "-tlsclient-basic",
          url,
          "fire-engine;tlsclient",
          false,
          logger.child({
            method: "evaluateURL",
            engine: "fire-engine;tlsclient",
            stealth: false,
          }),
        ),
        evaluateURL(
          job.id + "-tlsclient-stealth",
          url,
          "fire-engine;tlsclient;stealth",
          true,
          logger.child({
            method: "evaluateURL",
            engine: "fire-engine;tlsclient;stealth",
            stealth: true,
          }),
        ),
      ]),
    })),
  );

  // Transform results into format for native Levenshtein comparison
  const nativeInput: EngpickerUrlResult[] = results.map(result => {
    const cdpBasic = result.results.find(
      r => r.engine === "fire-engine;chrome-cdp",
    );
    const cdpStealth = result.results.find(
      r => r.engine === "fire-engine;chrome-cdp;stealth",
    );
    const tlsBasic = result.results.find(
      r => r.engine === "fire-engine;tlsclient",
    );
    const tlsStealth = result.results.find(
      r => r.engine === "fire-engine;tlsclient;stealth",
    );

    return {
      url: result.url,
      cdpBasicMarkdown: cdpBasic?.markdown ?? undefined,
      cdpBasicSuccess: cdpBasic?.result ?? false,
      cdpStealthMarkdown: cdpStealth?.markdown ?? undefined,
      cdpStealthSuccess: cdpStealth?.result ?? false,
      tlsBasicMarkdown: tlsBasic?.markdown ?? undefined,
      tlsBasicSuccess: tlsBasic?.result ?? false,
      tlsStealthMarkdown: tlsStealth?.markdown ?? undefined,
      tlsStealthSuccess: tlsStealth?.result ?? false,
    };
  });

  // Use native Rust implementation for fast Levenshtein comparison
  const SIMILARITY_THRESHOLD = 0.85; // 85% similarity means tlsclient is good enough
  const SUCCESS_RATE_THRESHOLD = 0.7; // 70% of comparable URLs must pass for tlsclient to be OK
  const CDP_FAILURE_THRESHOLD = 0.5; // If more than 50% of CDP scrapes failed, verdict is uncertain
  const verdictResult = await computeEngpickerVerdict(
    nativeInput,
    SIMILARITY_THRESHOLD,
    SUCCESS_RATE_THRESHOLD,
    CDP_FAILURE_THRESHOLD,
  );

  // This is the verdict - "TlsClientOk", "ChromeCdpRequired", or "Uncertain"
  const verdict = verdictResult.verdict;

  const { error: insertVerdictError } = await index_supabase_service
    .from("engpicker_verdicts")
    .insert({
      domain_hash: job.domain_hash,
      verdict,
    });

  if (insertVerdictError) {
    logger.error("Error inserting engpicker verdict", { insertVerdictError });
    await new Promise(resolve => setTimeout(resolve, 1000));
    return;
  }

  const { error: updateJobError } = await index_supabase_service
    .from("engpicker_queue")
    .update({
      done: true,
    })
    .eq("id", job.id);

  if (updateJobError) {
    logger.error("Error updating engpicker job", { updateJobError });
    await new Promise(resolve => setTimeout(resolve, 1000));
    return;
  }

  logger.info("Engpicker job completed", { verdict });
}
