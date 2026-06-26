import { z } from "zod";
import { config } from "../../../../config";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { Engine, EngineScrapeResult } from "../types";
import { Meta } from "../../lib/meta";

async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
    }),
    abort: meta.abort.asSignal(),
  });

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    url: meta.rewrittenUrl ?? meta.url, // TODO: impove redirect following
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,

    proxyUsed: "basic",
  };
}

export const playwrightEngine: Engine = {
  name: "playwright",
  features: {
    actions: false,
    waitFor: true,
    screenshot: false,
    "screenshot@fullScreen": false,
    audio: false,
    video: false,
    atsv: false,
    location: false,
    mobile: false,
    branding: false,
    disableAdblock: false,
  },
  scrape: meta => {
    const logger = meta.logger.child({
      method: "scrapeURLWithPlaywright",
      engine: "playwright",
    });

    return scrapeURLWithPlaywright({
      ...meta,
      logger,
    });
  },
};
