import type { Response } from "express";
import { config } from "../../../config";
import { keylessTeamUuid } from "../../../lib/keyless";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import { lookupJobWithRetry } from "./record";
import { isKeylessFeedbackRestricted } from "./zdr-persistence";
import { feedbackMetadataSchema, type RequestWithAuth } from "../types";
import { keylessFeedbackSchema } from "./keyless-schema";
import { KEYLESS_FEEDBACK_MAX_AGE_SEC } from "./keyless-limits";
import { insertKeylessFeedback } from "./keyless-store";
import { logger } from "../../../lib/logger";

export async function keylessFeedbackController(
  req: RequestWithAuth<any, any, any>,
  res: Response,
) {
  const fail = (status: number, feedbackErrorCode: string, error: string) =>
    res.status(status).json({ success: false, feedbackErrorCode, error });
  if (!config.KEYLESS_FEEDBACK_ENABLED || !config.USE_DB_AUTHENTICATION)
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
    const job = await lookupJobWithRetry(answers, identity, logger);
    if ("status" in job) return res.status(job.status).json(job.body);
    if (
      isKeylessFeedbackRestricted(
        answers.endpoint,
        job.options,
        req.acuc?.flags,
      )
    )
      return fail(
        404,
        "JOB_NOT_FOUND",
        "No eligible job found for this caller and category.",
      );
    const age = Date.now() - new Date(job.created_at).getTime();
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
    if (
      job.is_successful !== false &&
      answers.observations.some(item => item.kind === "failure")
    )
      return fail(
        400,
        "INVALID_BODY",
        "Failure observations require a failed job.",
      );
    let unverified = false;
    const options = job.options as {
      sources?: unknown;
      formats?: unknown;
    };
    if (answers.endpoint === "search") {
      const sources = requestedTypes(options.sources, "web");
      const positions = answers.observations.filter(
        item => item.kind === "useful" || item.kind === "irrelevant",
      );
      for (const item of positions) {
        if (!item.source && sources.length > 1)
          return fail(
            400,
            "INVALID_BODY",
            "Provide source when the job requested multiple sources.",
          );
        item.source ??= "web";
        if (!sources.includes(item.source))
          return fail(
            400,
            "INVALID_BODY",
            "Observation source must be a source requested by the job.",
          );
      }
      if (positions.length) {
        let results: unknown;
        try {
          results = await getJobFromGCS(job.id);
        } catch {
          // Ownership was verified in Postgres. Preserve observations if the artifact is unavailable.
        }
        if (!results || typeof results !== "object" || Array.isArray(results)) {
          unverified = true;
        } else {
          const groups = results as Record<string, unknown>;
          for (const item of positions) {
            const group = groups[item.source!];
            if (!Array.isArray(group) || !group[item.position - 1])
              return fail(
                400,
                "INVALID_BODY",
                "Each result position must exist in its requested, delivered source group.",
              );
          }
        }
      }
    } else {
      const formats = requestedTypes(options.formats, "markdown");
      const changeTrackingJson =
        Array.isArray(options.formats) &&
        options.formats.some(
          format =>
            format?.type === "changeTracking" && format.modes?.includes("json"),
        );
      for (const item of answers.observations) {
        if (item.kind === "failure") continue;
        if (item.format !== undefined && !formats.includes(item.format))
          return fail(
            400,
            "INVALID_BODY",
            "Observation format must be a format type requested by the job.",
          );
        if (
          item.basis !== "expectation" &&
          item.format === undefined &&
          formats.length > 1
        )
          return fail(
            400,
            "INVALID_BODY",
            "Provide format for output observations and source comparisons when the job requested multiple formats.",
          );
        if (item.kind === "incorrect") {
          const observedFormats = item.format ? [item.format] : formats;
          const compatible = observedFormats.some(format => {
            if (answers.endpoint === "parse")
              return format === "json" || format === "summary";
            if (item.reason === "missing_fields")
              return format === "json" || format === "deterministicJson";
            if (item.reason === "hallucinated")
              return (
                [
                  "json",
                  "deterministicJson",
                  "summary",
                  "question",
                  "highlights",
                ].includes(format) ||
                (format === "changeTracking" && changeTrackingJson)
              );
            return true;
          });
          if (!compatible)
            return fail(
              400,
              "INVALID_BODY",
              "Observation kind and reason must apply to the requested output format.",
            );
        }
      }
    }
    // Count the final metadata, including job-dependent defaults, before storing it.
    const metadata = {
      schemaVersion: 1,
      answers,
      ...(unverified ? { unverified: true as const } : {}),
    } as const;
    if (!feedbackMetadataSchema.safeParse(metadata).success)
      return fail(
        400,
        "INVALID_BODY",
        "Feedback must be 8 KiB (8192 bytes) or smaller. Shorten the task, assessment, or observations.",
      );
    const result = await insertKeylessFeedback(identity, metadata, job);
    if (!result.success)
      return fail(
        429,
        "DAILY_LIMIT_REACHED",
        `The daily limit of ${config.KEYLESS_FEEDBACK_DAILY_LIMIT} accepted submissions per caller IP was reached. It is shared across Search, Scrape, and Parse. Try another UTC day.`,
      );
    return res.status(200).json({ ...result, creditsRefunded: 0 });
  } catch {
    logger.warn("Keyless feedback submission failed", {
      canonicalLog: "keyless/feedback_submission_error",
      endpoint: answers.endpoint,
      jobId: answers.jobId,
    });
    return fail(
      503,
      "FEEDBACK_UNAVAILABLE",
      "Feedback could not be recorded. Retry later.",
    );
  }
}

function requestedTypes(value: unknown, defaultType: string): string[] {
  if (!Array.isArray(value)) return [defaultType];
  return [
    ...new Set(
      value
        .map(item => (typeof item === "string" ? item : item?.type))
        .filter((type): type is string => typeof type === "string"),
    ),
  ];
}
