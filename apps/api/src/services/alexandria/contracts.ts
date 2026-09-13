import { z } from "zod";

export const callSchema = z.strictObject({
  provider: z.string().min(1).max(200),
  capability: z.string().min(1).max(200),
  options: z.record(z.string(), z.unknown()).default({}),
});
export const callsSchema = z.array(callSchema).min(1).max(10);
export type ProviderCall = z.infer<typeof callSchema>;

const credits = z.number().int().nonnegative().safe();
const identity = { provider: z.string(), capability: z.string() };
const resultSchema = z.union([
  z
    .object({
      ...identity,
      creditsCost: credits,
      data: z.unknown().refine(value => value !== undefined),
      error: z.never().optional(),
    })
    .passthrough(),
  z
    .object({
      provider: z.string().optional(),
      capability: z.string().optional(),
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
export type DiscoveredTool = z.infer<typeof toolSchema> & {
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
