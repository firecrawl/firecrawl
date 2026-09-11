import type { Response } from "express";
import { config } from "../../../config";
import { keylessTeamUuid } from "../../../lib/keyless";
import { keylessFeedbackRedis } from "./keyless-redis";
import type { RequestWithAuth } from "../types";
import { keylessFeedbackSchema } from "./keyless-schema";
import {
  KEYLESS_FEEDBACK_MAX_AGE_SEC,
  keylessFeedbackContextKey,
  type KeylessFeedbackContext,
} from "./keyless-context";
import { insertKeylessFeedback } from "./keyless-store";

export async function keylessFeedbackController(
  req: RequestWithAuth<any, any, any>,
  res: Response,
) {
  const fail = (status: number, feedbackErrorCode: string, error: string) =>
    res.status(status).json({ success: false, feedbackErrorCode, error });
  if (
    !config.KEYLESS_FEEDBACK_ENABLED ||
    !config.USE_DB_AUTHENTICATION ||
    !keylessFeedbackRedis
  )
    return fail(
      503,
      "FEEDBACK_UNAVAILABLE",
      "Feedback is unavailable on this deployment.",
    );
  if (req.acuc?.flags?.searchFeedbackOptOut)
    return fail(403, "TEAM_OPTED_OUT", "Feedback is disabled for this caller.");
  const parsed = keylessFeedbackSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({
      success: false,
      feedbackErrorCode: "INVALID_BODY",
      error:
        "Provide a task, assessment, and category-appropriate observations.",
      details: parsed.error.issues,
    });
  const answers = parsed.data;
  const identity = keylessTeamUuid(req.auth.team_id)!;
  try {
    const stored = await keylessFeedbackRedis.get(
      keylessFeedbackContextKey(identity, answers.endpoint, answers.jobId),
    );
    if (!stored)
      return fail(
        404,
        "JOB_NOT_FOUND",
        "No eligible job found for this caller and category. Job references expire after 24 hours.",
      );
    const context: KeylessFeedbackContext = JSON.parse(stored);
    const age = Date.now() - Date.parse(context.createdAt);
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > KEYLESS_FEEDBACK_MAX_AGE_SEC * 1000
    )
      return fail(
        409,
        "FEEDBACK_WINDOW_EXPIRED",
        "Feedback must be submitted within 24 hours of the job.",
      );
    if (answers.endpoint === "search") {
      const groups = context.result as Record<string, unknown[]>;
      if (
        answers.observations.some(
          item =>
            "position" in item && !groups?.[item.source]?.[item.position - 1],
        )
      )
        return fail(
          400,
          "INVALID_BODY",
          "Each result position must exist in its delivered source group.",
        );
    }
    const result = await insertKeylessFeedback(identity, answers, context);
    if (!result.success)
      return fail(
        429,
        "DAILY_LIMIT_REACHED",
        "Feedback was already accepted for this identity today. The daily limit is shared across Search, Scrape, and Parse. Try another UTC day.",
      );
    return res.status(200).json({ ...result, creditsRefunded: 0 });
  } catch {
    return fail(
      503,
      "FEEDBACK_UNAVAILABLE",
      "Feedback could not be recorded. Retry later.",
    );
  }
}
