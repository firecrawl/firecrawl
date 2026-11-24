import { z } from "zod";
import { defineEnv } from "../service/env";

export const feedbackEnv = defineEnv(
  "feedback",
  z.object({
    SEARCH_FEEDBACK_MAX_AGE_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    SEARCH_FEEDBACK_DAILY_CAP_CREDITS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(100),
    FEEDBACK_MAX_AGE_SEC: z.coerce.number().int().positive().default(120),
    FEEDBACK_DAILY_CAP_CREDITS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(50),
    FEEDBACK_REFUND_ENABLED: z.stringbool().default(true),
    // Feedback window for interact and browser sessions, from their last activity.
    BROWSER_FEEDBACK_MAX_AGE_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(3600),
    // Kill switch for the feedback next step on Alexandria answers.
    ALEXANDRIA_FEEDBACK_HINT_ENABLED: z.stringbool().default(true),
    ALEXANDRIA_FEEDBACK_WINDOW_SEC: z.coerce
      .number()
      .int()
      .positive()
      .default(1200),
    ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(100),
    ALEXANDRIA_FEEDBACK_WEBSITE_DAILY_CAP_CREDITS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(10),
    BIGTABLE_FEEDBACK_JOBS_TABLE: z.string().optional(),
  }),
);
