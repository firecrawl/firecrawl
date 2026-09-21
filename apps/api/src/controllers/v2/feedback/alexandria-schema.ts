import { z } from "zod";

const detail = z.string().trim().min(1).max(2000);
const name = z.string().trim().min(1).max(200);
const providerFeedback = z.strictObject({
  name,
  issue: z.enum([
    "missing_provider",
    "insufficient_coverage",
    "provider_unavailable",
    "other",
  ]),
  why: detail,
});
const capabilityFeedback = z
  .strictObject({
    name,
    provider: name,
    issue: z.enum([
      "new_capability_request",
      "insufficient_functionality",
      "incorrect_result",
      "execution_error",
      "other",
    ]),
    why: detail,
    requestedFunctionality: detail.optional(),
  })
  .refine(
    value =>
      value.issue !== "new_capability_request" ||
      value.requestedFunctionality !== undefined,
    {
      path: ["requestedFunctionality"],
      message: "requestedFunctionality is required for new_capability_request",
    },
  );

export const alexandriaFeedbackSchema = z
  .strictObject({
    endpoint: z.literal("alexandria"),
    rating: z.enum(["good", "partial", "bad"]),
    requestedWebsite: z.strictObject({
      url: z.url({ protocol: /^https?$/ }).max(2048),
      requestedFunctionality: detail,
    }),
    rationale: detail,
    providerFeedback: z.array(providerFeedback).max(20).optional(),
    capabilityFeedback: z.array(capabilityFeedback).max(20).optional(),
    origin: z.string().trim().min(1).max(100).default("api"),
    integration: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .refine(
    value => new TextEncoder().encode(JSON.stringify(value)).length <= 8 * 1024,
    "Alexandria feedback must be 8KB or smaller",
  );

export type AlexandriaFeedbackRequest = z.infer<
  typeof alexandriaFeedbackSchema
>;
export type AlexandriaFeedbackRequestInput = z.input<
  typeof alexandriaFeedbackSchema
>;
