import { z } from "zod";

import { Meta } from "..";
import { EngineScrapeResult } from ".";
import { config } from "../../../config";
import {
  getExchangeRequestLogContext,
  getExchangeResponseLogContext,
  getThirdPartyDataTermsRequiredResponse,
} from "../../../lib/exchange";
import { setSpanAttributes, withSpan } from "../../../lib/otel-tracer";
import { robustFetch } from "../lib/fetch";
import {
  EngineError,
  EnrichmentNotEnabledError,
  ThirdPartyDataTermsRequiredError,
} from "../error";

const exchangeScrapeResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      accessEventId: z.string().optional(),
      // No .catch() here: a malformed credit cost must fail the scrape
      // loudly rather than silently billing 0 for a delivered access.
      creditsCost: z.number().int().nonnegative(),
      data: z
        .object({
          url: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          source: z
            .object({
              provider: z.string().optional(),
            })
            .passthrough()
            .optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          markdown: z.string().optional(),
          json: z.unknown().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      success: z.literal(false),
      error: z
        .object({
          code: z.string().optional(),
          message: z.string().optional(),
          terms: z.object({ key: z.string(), version: z.string() }).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
]);

const exchangeRefusalSchema = exchangeScrapeResponseSchema.options[1];

// The Exchange refusals a customer can act on, as the errors they see.
function refusalError(
  error: z.infer<typeof exchangeRefusalSchema>["error"],
): Error | undefined {
  const settingsUrl = `${config.FIRECRAWL_DASHBOARD_URL.replace(/\/+$/, "")}/app/alexandria?enrichment=true`;
  if (error?.code === "enrichment_not_enabled") {
    return new EnrichmentNotEnabledError(
      `LinkedIn scrapes run through your team's enrichment providers, and enrichment is not enabled for this kind of profile. An organization admin can choose providers at ${settingsUrl}`,
    );
  }
  if (error?.code === "enrichment_unavailable") {
    return new EnrichmentNotEnabledError(
      `None of your team's enrichment providers can serve this LinkedIn URL. An organization admin can change them at ${settingsUrl}`,
    );
  }
  if (error?.code === "third_party_data_terms_required" && error.terms) {
    return new ThirdPartyDataTermsRequiredError(
      error.terms,
      getThirdPartyDataTermsRequiredResponse(error.terms).error,
    );
  }
  return undefined;
}

export function exchangeMaxReasonableTime(meta: Meta): number {
  return meta.options.timeout ?? 60_000;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Exchange responses carry no page HTML; synthesize a minimal head so the
// metadata transformer can populate the document's title and description.
function buildMetadataHtml(title?: string, description?: string): string {
  const titleTag = title === undefined ? "" : `<title>${escapeHtml(title)}</title>`;
  const descriptionTag =
    description === undefined
      ? ""
      : `<meta name="description" content="${escapeHtml(description)}">`;
  return `<!DOCTYPE html><html><head>${titleTag}${descriptionTag}</head><body></body></html>`;
}

export async function scrapeURLWithExchange(
  meta: Meta,
): Promise<EngineScrapeResult> {
  return withSpan("engine.exchange.scrape", async span => {
    const startTime = Date.now();
    const url = meta.rewrittenUrl ?? meta.url;
    const requestLogContext = getExchangeRequestLogContext(url);
    const logger = meta.logger.child({ method: "scrapeURLWithExchange" });

    setSpanAttributes(span, {
      "engine.type": "exchange",
      // Follow the same credential redaction as the log context.
      "engine.url": requestLogContext?.url ?? "",
      "engine.team_id": meta.internalOptions.teamId,
    });

    logger.info("Exchange scrape started", {
      ...requestLogContext,
      scrapeId: meta.id,
      teamId: meta.internalOptions.teamId,
      maxAge: meta.options.maxAge,
    });

    try {
      const response = await robustFetch({
        url: `${config.FIRE_EXCHANGE_URL!.replace(/\/+$/, "")}/v1/scrape`,
        method: "POST",
        body: {
          requestId: meta.id,
          teamId: meta.internalOptions.teamId,
          url,
          formats: ["markdown", "json"],
          ...(meta.options.maxAge === undefined
            ? {}
            : { maxAge: meta.options.maxAge }),
          // The Exchange checks each enrichment step's provider terms against these.
          ...(meta.internalOptions.teamFlags?.organizationDataSourceAccess
            ? {
                organizationDataSourceAccess:
                  meta.internalOptions.teamFlags.organizationDataSourceAccess,
              }
            : {}),
        },
        logger: logger.child({ method: "exchangeScrape/robustFetch" }),
        tryCount: 2,
        ignoreFailureStatus: true,
        mock: meta.mock,
        abort: meta.abort.asSignal(),
        schema: exchangeScrapeResponseSchema,
      });

      if (!response.success) {
        logger.warn("Exchange scrape failed", {
          ...requestLogContext,
          scrapeId: meta.id,
          teamId: meta.internalOptions.teamId,
          errorCode: response.error?.code,
          durationMs: Date.now() - startTime,
        });
        throw (
          refusalError(response.error) ??
          new EngineError("Exchange request failed")
        );
      }

      const responseLogContext = getExchangeResponseLogContext(
        response.data.metadata,
      );

      logger.info("Exchange scrape completed", {
        ...requestLogContext,
        ...responseLogContext,
        scrapeId: meta.id,
        teamId: meta.internalOptions.teamId,
        integrationId: response.data.source?.provider,
        accessEventId: response.accessEventId,
        creditsCost: response.creditsCost,
        durationMs: Date.now() - startTime,
      });

      setSpanAttributes(span, {
        "exchange.integration_id": response.data.source?.provider,
        "exchange.credits_cost": response.creditsCost,
        "exchange.cache_state": responseLogContext.cacheState,
        "exchange.cache_age_ms": responseLogContext.cacheAgeMs,
        "exchange.duration_ms": Date.now() - startTime,
      });

      return {
        url: response.data.url ?? url,
        html: buildMetadataHtml(response.data.title, response.data.description),
        markdown: response.data.markdown,
        json: response.data.json,
        statusCode: 200,
        contentType: "text/markdown",
        proxyUsed: "basic",
        exchange: {
          handled: true,
          creditsCost: response.creditsCost,
          ...(response.accessEventId === undefined
            ? {}
            : { accessEventId: response.accessEventId }),
          ...(response.data.source?.provider === undefined
            ? {}
            : { integrationId: response.data.source.provider }),
        },
      };
    } catch (error) {
      logger.warn("Exchange scrape errored", {
        ...requestLogContext,
        scrapeId: meta.id,
        teamId: meta.internalOptions.teamId,
        durationMs: Date.now() - startTime,
        errorMessage: error instanceof Error ? error.message : String(error),
        error,
      });
      throw error;
    }
  });
}
