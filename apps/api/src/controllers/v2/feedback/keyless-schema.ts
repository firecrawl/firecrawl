import { z } from "zod";

const detail = z.string().trim().min(10).max(2000);
const comparison = z.strictObject({
  reference: z.string().trim().min(1).max(2048),
  detail,
});
const evidence = {
  detail,
  basis: z.enum(["output", "source_comparison", "expectation"]),
  comparison: comparison.optional(),
};
const observation = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ ...evidence, ...shape }).refine(
    value => {
      const item = value as { basis: string; comparison?: unknown };
      return item.basis !== "source_comparison" || !!item.comparison;
    },
    {
      message:
        "Source comparisons require a reference and observed difference.",
    },
  );
const common = {
  jobId: z.uuid(),
  rating: z.enum(["good", "partial", "bad"]),
  task: detail,
  assessment: detail,
  origin: z.string().trim().max(100).optional().default("api"),
  integration: z.string().trim().max(100).nullable().optional(),
};
const searchObservation = z.union([
  observation({
    kind: z.enum(["useful", "irrelevant"]),
    source: z.enum(["web", "images", "news"]),
    position: z.number().int().min(1).max(100),
  }),
  observation({
    kind: z.literal("missing"),
    topic: z.string().trim().min(1).max(200),
    knownSources: z
      .array(z.url({ protocol: /^https?$/ }))
      .max(20)
      .optional(),
  }),
]);

export const keylessFeedbackSchema = z.discriminatedUnion("endpoint", [
  z.strictObject({
    ...common,
    endpoint: z.literal("search"),
    observations: z.array(searchObservation).min(1).max(20),
  }),
  z.strictObject({
    ...common,
    endpoint: z.literal("scrape"),
    observations: z
      .array(
        observation({
          kind: z.enum(["correct", "missing", "incorrect", "failure"]),
          location: z.string().trim().min(1).max(500).optional(),
          retryOutcome: detail.optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
  z.strictObject({
    ...common,
    endpoint: z.literal("parse"),
    observations: z
      .array(
        observation({
          kind: z.enum(["correct", "text", "table", "layout", "completeness"]),
          location: z.string().trim().min(1).max(500).optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
]);

export type KeylessFeedbackRequest = z.infer<typeof keylessFeedbackSchema>;
export type KeylessFeedbackEndpoint = KeylessFeedbackRequest["endpoint"];
