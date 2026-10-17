import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "../../../db/connection";
import { job_feedback, job_feedback_observations } from "../../../db/schema";
import type { KeylessFeedbackRequest } from "./keyless-schema";
import type { FeedbackJobRow } from "./internal-types";

// Every field an observation can carry; each endpoint uses a subset.
type ObservationFields = {
  kind: string;
  reason?: string;
  basis: string;
  detail: string;
  comparison?: { reference: string; detail: string };
  source?: string;
  position?: number;
  vertical?: string;
  topic?: string;
  knownSources?: string[];
  format?: string;
  location?: string;
  page?: number;
};

export async function insertKeylessFeedback(
  identity: string,
  metadata: {
    schemaVersion: 1;
    answers: KeylessFeedbackRequest;
    unverified?: true;
  },
  job: FeedbackJobRow,
): Promise<{ success: true; feedbackId: string; alreadySubmitted?: true }> {
  const { answers } = metadata;
  const jobStatus = job.is_successful === false ? "failed" : "completed";
  // job_feedback holds one row per caller, endpoint, and job. A concurrent
  // retry waits on that unique key, inserts nothing, and returns the winner.
  return db.transaction(async tx => {
    const [inserted] = await tx
      .insert(job_feedback)
      .values({
        id: uuidv7(),
        team_id: identity,
        auth_type: "keyless",
        endpoint: answers.endpoint,
        job_id: job.id,
        request_id: job.request_id,
        job_status: jobStatus,
        rating: answers.rating,
        task: answers.task,
        assessment: answers.assessment,
        doc_class: answers.endpoint === "parse" ? answers.docClass : null,
        origin: answers.origin,
        integration: answers.integration ?? null,
        unverified: metadata.unverified === true,
        schema_version: metadata.schemaVersion,
      })
      .onConflictDoNothing()
      .returning({ id: job_feedback.id });

    if (!inserted) {
      const [existing] = await tx
        .select({ id: job_feedback.id })
        .from(job_feedback)
        .where(
          and(
            eq(job_feedback.team_id, identity),
            eq(job_feedback.endpoint, answers.endpoint),
            eq(job_feedback.job_id, job.id),
          ),
        )
        .limit(1);
      if (!existing)
        throw new Error("Conflicting keyless feedback was not found");
      return {
        success: true as const,
        feedbackId: existing.id,
        alreadySubmitted: true as const,
      };
    }

    await tx.insert(job_feedback_observations).values(
      (answers.observations as ObservationFields[]).map((item, position) => ({
        feedback_id: inserted.id,
        team_id: identity,
        endpoint: answers.endpoint,
        job_status: jobStatus,
        position,
        kind: item.kind,
        reason: item.reason ?? null,
        basis: item.basis,
        detail: item.detail,
        comparison_reference: item.comparison?.reference ?? null,
        comparison_detail: item.comparison?.detail ?? null,
        source: item.source ?? null,
        result_position: item.position ?? null,
        vertical: item.vertical ?? null,
        topic: item.topic ?? null,
        known_sources: item.knownSources ?? [],
        format: item.format ?? null,
        location: item.location ?? null,
        page: item.page ?? null,
      })),
    );
    return { success: true as const, feedbackId: inserted.id };
  });
}
