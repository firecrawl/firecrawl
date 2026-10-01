import { generateObject } from "ai";
import { z } from "zod";
import { scrapeOptions } from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import type { Engine } from "../scraper/scrapeURL/engines";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { dbIndex } from "../db/connection";
import * as schema from "../db/schema";
import { queryIndexAtDomainSplitLevelOmce } from "../db/rpc";
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
  domain_hash: Buffer;
  domain_level: number;
  picked_up_at: string | null;
  done: boolean;
  created_at: string;
};

/**
 * `evaluated` distinguishes "the model judged this scrape unsuccessful" from
 * "the evaluation never produced a verdict". A provider or transport failure
 * is not evidence about the scrape, and recording it as `result: false` would
 * let an outage masquerade as an engine-quality verdict in the index.
 */
export type EngpickerEvaluation = {
  engine: Engine;
  stealth: boolean;
  markdown: string | null;
  result: boolean;
  evaluated: boolean;
};

export async function evaluateURL(
  id: string,
  url: string,
  engine: Engine,
  stealth: boolean,
  logger: Logger,
): Promise<EngpickerEvaluation> {
  // The whole per-engine operation is isolated. `processEngpickerJob` awaits
  // every engine inside a single Promise.all, so any rejection here would skip
  // the verdict insert and the `done: true` update and leave the queue row
  // permanently picked up. Both a thrown scrape and a failed evaluation are
  // therefore unavailable observations rather than negative verdicts.
  try {
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
        orgId: null,
      },
      new CostTracking(),
    );

    if (!scrapeResult.success) {
      // A reported scrape failure is real evidence about the engine.
      logger.warn("Scrape failed", { scrapeResult });
      return {
        engine,
        stealth,
        markdown: null,
        result: false,
        evaluated: true,
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
      evaluated: true,
    };
  } catch (error) {
    logger.warn("Engpicker evaluation unavailable for this engine", {
      error,
      stage: "scrape-or-evaluation",
      url,
      engine,
    });
    return {
      engine,
      stealth,
      markdown: null,
      result: false,
      evaluated: false,
    };
  }
}

/**
 * Map evaluation results onto the fixed-shape native input.
 *
 * `EngpickerUrlResult` can only encode booleans, so a URL is eligible for
 * native scoring only when every engine result needed for its comparison was
 * actually evaluated. Converting an unavailable evaluation into
 * `success: false` would fabricate engine-quality evidence: with CDP
 * evaluations succeeding and TLS evaluations unavailable, the native scorer
 * would read that as "TLS insufficient" and could conclude ChromeCdpRequired.
 * A URL with missing evidence is therefore excluded from the sample entirely.
 *
 * Genuine negative evaluations (`evaluated: true`, `result: false`) are real
 * evidence and are kept.
 */
export function buildEngpickerNativeInput(
  results: { url: string; results: EngpickerEvaluation[] }[],
): EngpickerUrlResult[] {
  const nativeInput: EngpickerUrlResult[] = [];
  for (const result of results) {
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

    // Missing evidence in any of the four observations makes this URL
    // unusable for a per-engine comparison, so it is not scored at all.
    if (
      ![cdpBasic, cdpStealth, tlsBasic, tlsStealth].every(r => r?.evaluated)
    ) {
      continue;
    }

    nativeInput.push({
      url: result.url,
      cdpBasicMarkdown: cdpBasic!.markdown ?? undefined,
      cdpBasicSuccess: cdpBasic!.result,
      cdpStealthMarkdown: cdpStealth!.markdown ?? undefined,
      cdpStealthSuccess: cdpStealth!.result,
      tlsBasicMarkdown: tlsBasic!.markdown ?? undefined,
      tlsBasicSuccess: tlsBasic!.result,
      tlsStealthMarkdown: tlsStealth!.markdown ?? undefined,
      tlsStealthSuccess: tlsStealth!.result,
    });
  }
  return nativeInput;
}

export async function processEngpickerJob() {
  let logger = _logger.child({
    module: "engpicker",
    method: "processEngpickerJob",
  });

  let jobData: EngpickerJob[];
  try {
    const candidate = dbIndex
      .select({ id: schema.engpicker_queue.id })
      .from(schema.engpicker_queue)
      .where(isNull(schema.engpicker_queue.picked_up_at))
      .orderBy(desc(schema.engpicker_queue.created_at))
      .limit(1);

    jobData = await dbIndex
      .update(schema.engpicker_queue)
      .set({ picked_up_at: new Date().toISOString() })
      .where(
        and(
          inArray(schema.engpicker_queue.id, candidate),
          isNull(schema.engpicker_queue.picked_up_at),
        ),
      )
      .returning();
  } catch (getJobError) {
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

  let indexRows: { url: string }[];
  try {
    indexRows = await queryIndexAtDomainSplitLevelOmce<{ url: string }>(
      job.domain_level,
      job.domain_hash,
      new Date(
        new Date(job.created_at).valueOf() - 1000 * 60 * 60 * 24,
      ).toISOString(),
      100,
    );
  } catch (indexRowsError) {
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

  const nativeInput = buildEngpickerNativeInput(results);
  if (nativeInput.length === 0) {
    // No URL had complete evidence, so there is nothing to compare. Recording
    // Uncertain is correct and avoids asking the scorer to infer engine
    // quality from an empty sample.
    logger.warn("No engpicker sample had complete evaluation evidence", {
      verdict: "Uncertain",
    });
    try {
      await dbIndex.insert(schema.engpicker_verdicts).values({
        domain_hash: job.domain_hash,
        verdict: "Uncertain",
      });
      await dbIndex
        .update(schema.engpicker_queue)
        .set({ done: true })
        .where(eq(schema.engpicker_queue.id, job.id));
    } catch (persistError) {
      logger.error("Error persisting uncertain engpicker verdict", {
        persistError,
      });
    }
    return;
  }

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

  try {
    await dbIndex.insert(schema.engpicker_verdicts).values({
      domain_hash: job.domain_hash,
      verdict,
    });
  } catch (insertVerdictError) {
    logger.error("Error inserting engpicker verdict", { insertVerdictError });
    await new Promise(resolve => setTimeout(resolve, 1000));
    return;
  }

  try {
    await dbIndex
      .update(schema.engpicker_queue)
      .set({ done: true })
      .where(eq(schema.engpicker_queue.id, job.id));
  } catch (updateJobError) {
    logger.error("Error updating engpicker job", { updateJobError });
    await new Promise(resolve => setTimeout(resolve, 1000));
    return;
  }

  logger.info("Engpicker job completed", { verdict });
}
