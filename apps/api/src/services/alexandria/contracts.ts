import { z } from "zod";

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const callSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  capability: z.string().min(1).max(200),
  version: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    )
    .optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});
export const callsSchema = z.array(callSchema).min(1).max(10);
export type ProviderCall = z.infer<typeof callSchema>;

const credits = z.number().int().nonnegative().safe();
const identity = { provider: z.string(), capability: z.string() };
// Where Exchange says the provider is built; logged per call, never returned to the caller.
// An unknown or null value is dropped rather than failing a call that already ran.
const provenance = z
  .enum(["connector", "exchange", "workflows_programs"])
  .nullish()
  .catch(undefined);
const resultSchema = z.union([
  z
    .object({
      ...identity,
      provenance,
      creditsCost: credits,
      data: z.unknown().refine(value => value !== undefined),
      error: z.never().optional(),
    })
    .passthrough(),
  z
    .object({
      provider: z.string().optional(),
      capability: z.string().optional(),
      provenance,
      creditsCost: z.literal(0).optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          status: z.number().int().min(100).max(999).optional(),
        })
        .passthrough(),
    })
    .passthrough(),
]);
export const answerSchema = z.object({
  success: z.literal(true),
  creditsCost: credits,
  results: z.array(resultSchema).min(1).max(10),
});

export const toolSchema = z
  .object({
    provider: z.string(),
    capability: z.string(),
    name: z.string(),
    description: z.string(),
    creditsCost: credits,
    perRecord: z.boolean(),
    options: z.array(
      z.object({ name: z.string(), type: z.string() }).passthrough(),
    ),
    response: z
      .object({
        about: z.string(),
        key: z.string(),
        fields: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();
export const toolSummarySchema = toolSchema
  .omit({ options: true, response: true })
  .strip()
  .extend({
    next: callSchema.passthrough().optional().catch(undefined),
    attribution: z.unknown().optional(),
    recordsPerUnit: z.number().positive().optional(),
    zeroDataRetentionCreditsCost: credits.optional(),
  });
export type DetailedDiscoveredTool = (
  | z.infer<typeof toolSchema>
  | z.infer<typeof toolSummarySchema>
) & {
  id: string;
  matchedBy: ("semantic" | "domain")[];
  matchedUrls: string[];
};

export type ExchangeResponse = { status: number; body: unknown };
export const refusal = (
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): ExchangeResponse => ({
  status,
  body: { success: false, error, ...extra },
});

type CompactDiscoveredTool = Pick<
  z.infer<typeof toolSummarySchema>,
  "provider" | "capability" | "description"
>;
export type DiscoveredTool = CompactDiscoveredTool | DetailedDiscoveredTool;
