import { z } from "zod";

import { Meta } from "..";
import { EngineScrapeResult } from ".";
import { config } from "../../../config";
import {
  getExchangeRequestLogContext,
  getEnrichmentSettingsUrl,
  getExchangeResponseLogContext,
  ThirdPartyDataTermsRequiredError,
} from "../../../lib/exchange";
import { setSpanAttributes, withSpan } from "../../../lib/otel-tracer";
import { robustFetch } from "../lib/fetch";
import { safeMarkdownToHtml } from "./pdf/markdownToHtml";
import { EngineError, ExchangeRefusedError } from "../error";

// The enrichment waterfall's record of which provider matched and every
// provider it tried, in order.
const exchangeEnrichmentSchema = z.object({
  source: z.object({ provider: z.string() }),
  steps: z
    .array(
      z.object({
        provider: z.string(),
        status: z.string(),
        creditsCost: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1),
});

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
              provider: z.string(),
            })
            .passthrough(),
          metadata: z
            .object({
              // Unreadable enrichment metadata reports the provider directly
              // instead of failing a delivered scrape.
              enrichment: exchangeEnrichmentSchema.optional().catch(undefined),
            })
            .passthrough()
            .optional(),
          markdown: z.string().optional(),
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

// Exchange refusals that describe the request itself. Any other failure is an
// engine failure. Enrichment refusals point at the settings that fix them.
const EXCHANGE_REFUSALS = new Map<
  string,
  {
    code: ConstructorParameters<typeof ExchangeRefusedError>[0];
    message: string;
    enrichmentSettings?: true;
    // Set when the Exchange's message describes its own URL contract, which
    // means nothing to a scrape caller.
    ignoreExchangeMessage?: true;
  }
>([
  [
    "record_not_found",
    {
      code: "THIRD_PARTY_DATA_NOT_FOUND",
      message:
        "The third-party data provider for this URL has no record for it.",
    },
  ],
  [
    "not_found",
    {
      code: "THIRD_PARTY_DATA_NOT_FOUND",
      message:
        "The third-party data provider for this URL has no record for it.",
    },
  ],
  [
    "invalid_exchange_url",
    {
      code: "THIRD_PARTY_DATA_UNSUPPORTED_URL",
      message:
        "The third-party data provider for this site does not serve this URL. Request a record's own page, such as a profile page itself, rather than a sub-page or listing under it.",
      ignoreExchangeMessage: true,
    },
  ],
  [
    "provider_not_enabled",
    {
      code: "THIRD_PARTY_DATA_NOT_ENABLED",
      message:
        "The third-party data provider for this URL is not enabled for this team.",
    },
  ],
  [
    "enrichment_not_enabled",
    {
      code: "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
      message: "Enrichment is not enabled for this kind of profile.",
      enrichmentSettings: true,
    },
  ],
  [
    "enrichment_unavailable",
    {
      code: "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
      message: "None of the team's enrichment providers can serve this URL.",
      enrichmentSettings: true,
    },
  ],
]);

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

// Exchange responses carry no page HTML. Render the markdown into a page so
// the regular transformers derive html, rawHtml, links, images and metadata
// from it the way they do for any other page.
function buildPageHtml(
  body: string,
  title?: string,
  description?: string,
): string {
  const titleTag =
    title === undefined ? "" : `<title>${escapeHtml(title)}</title>`;
  const descriptionTag =
    description === undefined
      ? ""
      : `<meta name="description" content="${escapeHtml(description)}">`;
  return `<!DOCTYPE html><html><head>${titleTag}${descriptionTag}</head><body>${body}</body></html>`;
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
          // Named so the Exchange serves the provider whose access was checked
          // when several claim the URL.
          ...(meta.exchangeProviderId === undefined
            ? {}
            : { provider: meta.exchangeProviderId }),
          formats: ["markdown"],
          ...(meta.options.maxAge === undefined
            ? {}
            : { maxAge: meta.options.maxAge }),
          // Enrichment checks each provider step's terms against these rows
          // and the Exchange's own ledger for the organization.
          ...(meta.internalOptions.orgId
            ? { organizationId: meta.internalOptions.orgId }
            : {}),
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
        if (
          response.error?.code === "third_party_data_terms_required" &&
          response.error.terms !== undefined
        ) {
          // Only enrichment checks terms inside the Exchange, so the step can
          // also be turned off in the team's enrichment settings.
          throw new ThirdPartyDataTermsRequiredError(response.error.terms, {
            enrichment: true,
          });
        }
        const refusal = EXCHANGE_REFUSALS.get(response.error?.code ?? "");
        if (refusal !== undefined) {
          const message = refusal.ignoreExchangeMessage
            ? refusal.message
            : response.error?.message || refusal.message;
          throw new ExchangeRefusedError(
            refusal.code,
            refusal.enrichmentSettings
              ? `${message} An organization admin can choose enrichment providers at ${getEnrichmentSettingsUrl()}`
              : message,
          );
        }
        throw new EngineError("Exchange request failed");
      }

      const responseLogContext = getExchangeResponseLogContext(
        response.data.metadata,
      );
      const enrichment = response.data.metadata?.enrichment;
      const providerId =
        enrichment?.source.provider ?? response.data.source.provider;

      logger.info("Exchange scrape completed", {
        ...requestLogContext,
        ...responseLogContext,
        scrapeId: meta.id,
        teamId: meta.internalOptions.teamId,
        integrationId: response.data.source.provider,
        providerId,
        accessEventId: response.accessEventId,
        creditsCost: response.creditsCost,
        durationMs: Date.now() - startTime,
      });

      setSpanAttributes(span, {
        "exchange.integration_id": response.data.source.provider,
        "exchange.credits_cost": response.creditsCost,
        "exchange.cache_state": responseLogContext.cacheState,
        "exchange.cache_age_ms": responseLogContext.cacheAgeMs,
        "exchange.duration_ms": Date.now() - startTime,
      });

      const markdown = response.data.markdown ?? "";
      return {
        url: response.data.url ?? url,
        html: buildPageHtml(
          await safeMarkdownToHtml(markdown, meta.logger, meta.id),
          response.data.title,
          response.data.description,
        ),
        markdown,
        statusCode: 200,
        contentType: "text/markdown",
        proxyUsed: "basic",
        exchange: {
          ...(response.accessEventId === undefined
            ? {}
            : { accessEventId: response.accessEventId }),
          provider: {
            id: providerId,
            creditsCost: response.creditsCost,
            steps: enrichment?.steps ?? [
              {
                provider: providerId,
                status: "matched",
                creditsCost: response.creditsCost,
              },
            ],
          },
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
