import { z } from "zod";
import { integrationSchema } from "../../../utils/integration";
import { MAX_FEEDBACK_TOKEN_LENGTH } from "../../../lib/alexandria-feedback-token";

const detail = z.string().trim().min(1).max(2000);
const name = z.string().trim().min(1).max(200);
const rating = z.enum(["good", "partial", "bad"]);
const feedbackToken = z.string().min(1).max(MAX_FEEDBACK_TOKEN_LENGTH);
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
      "missing_capability",
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
    rating,
    requestedWebsite: z.strictObject({
      url: z.url({ protocol: /^https?$/ }).max(2048),
      requestedFunctionality: detail,
    }),
    rationale: detail,
    // Optional so clients released before the field keep working.
    objective: detail.optional(),
    // feedbackToken values of the provider calls the rating covers.
    tokens: z.array(feedbackToken).max(20).optional(),
    callRatings: z
      .array(z.strictObject({ token: feedbackToken, rating }))
      .max(20)
      .optional(),
    providerFeedback: z.array(providerFeedback).max(20).optional(),
    capabilityFeedback: z.array(capabilityFeedback).max(20).optional(),
    origin: z.string().trim().min(1).max(100).default("api"),
    integration: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .pipe(integrationSchema)
      .nullable()
      .optional(),
  })
  .refine(
    // Bound normalized feedback after trimming and applying defaults. Tokens
    // are bounded by their own limits.
    ({ tokens: _tokens, callRatings: _callRatings, ...value }) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= 8 * 1024,
    "Normalized feedback payload must be 8 KiB or smaller",
  );

export type AlexandriaFeedbackRequest = z.infer<
  typeof alexandriaFeedbackSchema
>;
