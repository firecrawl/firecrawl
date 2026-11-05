import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";

/**
 * Lightweight browser engines (Lightpanda, Moli).
 *
 * Both engines are driven over CDP by the playwright microservice, exactly
 * like the `playwright` engine: the API sends the same POST body plus an
 * `engine` discriminator, and the service connects to the configured CDP
 * endpoint with `chromium.connectOverCDP` instead of launching Chromium.
 *
 * Capability contract (enforced by the feature table in `engines/index.ts`):
 * these engines only ever receive requests whose feature flags they fully
 * support (currently: plain scrapes and `waitFor`). Requests that need
 * screenshots, PDFs, actions, branding, location, mobile emulation or a
 * stealth proxy never reach this code — the waterfall routes them to the
 * Chromium engines instead.
 *
 * Anything that looks like a failed render (empty content, a service-side
 * error) is thrown, so the waterfall falls through to the next engine
 * instead of returning an empty page as a successful scrape.
 */
export type LightBrowserKind = "lightpanda" | "moli";

async function scrapeURLWithLightBrowser(
  meta: Meta,
  kind: LightBrowserKind,
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
      engine: kind,
    },
    method: "POST",
    logger: meta.logger.child(`scrapeURLWithLightBrowser(${kind})/robustFetch`),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
      // Optional: older playwright-service builds don't send it.
      url: z.string().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  let content = response.content;
  if (response.contentType?.includes("application/json")) {
    content = await getInnerJson(content);
  }

  // A lightweight engine that could not run the page typically answers with
  // an empty shell. Treat that as an engine failure so the next tier
  // (Moli after Lightpanda, Chromium after Moli) gets its chance.
  if (!content || content.trim() === "") {
    throw new Error(`${kind} returned empty content`);
  }

  return {
    url: landedHttpUrl(response.url) ?? meta.rewrittenUrl ?? meta.url,
    html: content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,

    proxyUsed: "basic",
  };
}

function landedHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function scrapeURLWithLightpanda(
  meta: Meta,
): Promise<EngineScrapeResult> {
  return scrapeURLWithLightBrowser(meta, "lightpanda");
}

export async function scrapeURLWithMoli(
  meta: Meta,
): Promise<EngineScrapeResult> {
  return scrapeURLWithLightBrowser(meta, "moli");
}

export function lightBrowserMaxReasonableTime(meta: Meta): number {
  return (meta.options.waitFor ?? 0) + 30000;
}
