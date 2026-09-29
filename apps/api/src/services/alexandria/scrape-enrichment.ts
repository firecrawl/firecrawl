import { z } from "zod";
import type { ErrorCodes } from "../../lib/error";
import { answerSchema, type ExchangeResponse } from "./contracts";

export type EnrichmentTarget = {
  url: string;
  entity: "person" | "company";
};
export function enrichmentTarget(input: unknown): EnrichmentTarget | null {
  if (typeof input !== "string" || input.length > 2048 || /[\\\s]/.test(input))
    return null;
  // Inspect raw authority before URL normalization removes explicit default ports.
  const authority = input.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  if (!authority || authority.includes(":") || authority.includes("@"))
    return null;
  try {
    const url = new URL(input);
    if (
      url.hostname !== "linkedin.com" &&
      !url.hostname.endsWith(".linkedin.com")
    )
      return null;
    const path = /^\/(in|company)\/([^/]+)\/?$/.exec(url.pathname);
    if (!path) return null;
    const slug = decodeURIComponent(path[2]);
    if (
      !slug ||
      /[\s\x00-\x1f\x7f/\\?#%]/.test(slug) ||
      [".", ".."].includes(slug)
    )
      return null;
    return {
      url: `https://www.linkedin.com/${path[1]}/${encodeURIComponent(slug)}`,
      entity: path[1] === "in" ? "person" : "company",
    };
  } catch {
    return null;
  }
}

export type EnrichmentScrape = EnrichmentTarget & {
  format: "json" | "markdown";
};

export function enrichmentSetupError(input: unknown, teamId: string) {
  if (!enrichmentTarget(input)) return null;
  const redirect = `/app/t/${encodeURIComponent(teamId)}/alexandria?enrichment=true`;
  const url = `https://www.firecrawl.dev/signin?redirect=${encodeURIComponent(redirect)}`;
  return {
    error: `This LinkedIn profile cannot be scraped directly. Set up licensed profile enrichment and review provider terms: ${url}`,
    details: { action: { label: "Set up profile enrichment", url } },
  };
}
const formatSchema = z.union([
  z.enum(["json", "markdown"]),
  z
    .strictObject({ type: z.enum(["json", "markdown"]) })
    .transform(value => value.type),
]);
const requestSchema = z.strictObject({
  url: z.string(),
  onlyMainContent: z.literal(false).optional(),
  formats: z.array(formatSchema).length(1).default(["markdown"]),
  timeout: z.number().optional(),
  origin: z.string().optional(),
  integration: z.string().nullable().optional(),
});

export function enrichmentFormat(
  body: unknown,
): EnrichmentScrape["format"] | null {
  const parsed = requestSchema.safeParse(body);
  return parsed.success ? parsed.data.formats[0] : null;
}

const stepSchema = z.object({
  provider: z.string(),
  capability: z.string(),
  status: z.string(),
  error: z
    .object({ code: z.string(), status: z.number().optional() })
    .optional(),
});
const payloadSchema = z.object({
  status: z.enum([
    "matched",
    "disabled",
    "unavailable",
    "not_found",
    "stopped",
    "budget_exceeded",
  ]),
  entity: z.enum(["person", "company"]),
  url: z.string(),
  profile: z.record(z.string(), z.unknown()).optional(),
  markdown: z.string().optional(),
  source: z
    .object({ provider: z.string(), capability: z.string() })
    .passthrough()
    .optional(),
  steps: z.array(stepSchema),
  providerCredits: z.number().int().nonnegative(),
  billingComplete: z.boolean(),
});

export function enrichmentResponse(
  result: ExchangeResponse & { scrapeId?: string },
  target: EnrichmentScrape,
  teamId: string,
): ExchangeResponse {
  const redirect = `/app/t/${encodeURIComponent(teamId)}/alexandria?enrichment=true`;
  const action = {
    label: "Configure enrichment and review provider terms",
    url: `https://www.firecrawl.dev/signin?redirect=${encodeURIComponent(redirect)}`,
  };
  const fail = (
    status: number,
    code: ErrorCodes,
    error: string,
    setup = false,
    extra = {},
  ) => ({
    status,
    body: {
      success: false,
      code,
      error: setup ? `${error} ${action.url}` : error,
      scrape_id: result.scrapeId,
      details: { ...extra, ...(setup ? { action } : {}) },
    },
  });
  if (result.status !== 200) return result;
  const answer = answerSchema.safeParse(result.body);
  if (
    !answer.success ||
    answer.data.results.length !== 1 ||
    answer.data.creditsCost !== 0
  )
    return fail(
      502,
      "ENRICHMENT_INVALID_RESPONSE",
      "Enrichment returned an invalid response.",
    );
  const entry = answer.data.results[0];
  if (entry.error)
    return fail(
      502,
      "ENRICHMENT_UNAVAILABLE",
      "Enrichment could not execute. Retry with the same x-request-id.",
    );
  if (entry.provider !== "firecrawl" || entry.capability !== "enrich")
    return fail(
      502,
      "ENRICHMENT_INVALID_RESPONSE",
      "Enrichment returned an unexpected capability.",
    );
  const parsed = payloadSchema.safeParse(entry.data);
  if (
    !parsed.success ||
    parsed.data.entity !== target.entity ||
    parsed.data.url !== target.url
  )
    return fail(
      502,
      "ENRICHMENT_INVALID_RESPONSE",
      "Enrichment returned an invalid profile response.",
    );
  const data = parsed.data;
  const billing = {
    creditsUsed: data.providerCredits,
    billingComplete: data.billingComplete,
  };
  switch (data.status) {
    case "disabled":
    case "unavailable":
      return fail(
        403,
        "ENRICHMENT_SETUP_REQUIRED",
        "Enable enrichment and select providers for this profile type.",
        true,
        billing,
      );
    case "not_found":
      return fail(
        404,
        "ENRICHMENT_NOT_FOUND",
        "No selected provider found this profile.",
        false,
        billing,
      );
    case "budget_exceeded":
      return fail(
        402,
        "ENRICHMENT_BUDGET_EXCEEDED",
        "The saved enrichment credit limit was reached.",
        true,
        billing,
      );
    case "stopped": {
      const error = data.steps.find(step => step.error)?.error;
      if (error?.status === 403)
        return fail(
          403,
          "ENRICHMENT_ACCESS_REQUIRED",
          "Review provider access and terms for this team before retrying.",
          true,
          billing,
        );
      return fail(
        error?.status === 504 ? 504 : 502,
        "ENRICHMENT_PROVIDER_ERROR",
        "Enrichment stopped after a provider error. Charges may have occurred; retry only with the same x-request-id.",
        false,
        billing,
      );
    }
    case "matched":
      if (
        !data.source ||
        !data.billingComplete ||
        (target.format === "json" ? !data.profile : !data.markdown)
      )
        return fail(
          502,
          "ENRICHMENT_INVALID_RESPONSE",
          "Enrichment returned an incomplete profile.",
          false,
          billing,
        );
      return {
        status: 200,
        body: {
          success: true,
          scrape_id: result.scrapeId,
          data: {
            ...(target.format === "json"
              ? { json: data.profile }
              : { markdown: data.markdown }),
            metadata: { sourceURL: target.url, statusCode: 200 },
            enrichment: {
              entity: data.entity,
              source: data.source,
              ...billing,
            },
          },
        },
      };
  }
}
