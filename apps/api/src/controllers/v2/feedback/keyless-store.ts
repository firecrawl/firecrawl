import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "../../../db/connection";
import { search_feedback } from "../../../db/schema";
import type { KeylessFeedbackRequest } from "./keyless-schema";
import type { FeedbackJobRow } from "./internal-types";

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
  // The unique (team_id, endpoint, job_id) index keeps one record per job. A
  // concurrent retry waits for the first insert, then reads its record below.
  const [inserted] = await db
    .insert(search_feedback)
    .values({
      id: uuidv7(),
      endpoint: answers.endpoint,
      job_id: job.id,
      request_id: job.request_id,
      search_id: answers.endpoint === "search" ? answers.jobId : null,
      team_id: identity,
      overall_rating: answers.rating,
      comment: answers.assessment,
      origin: answers.origin,
      integration: answers.integration ?? null,
      job_status: job.is_successful === false ? "failed" : "completed",
      metadata,
    })
    .onConflictDoNothing({
      target: [
        search_feedback.team_id,
        search_feedback.endpoint,
        search_feedback.job_id,
      ],
    })
    .returning({ id: search_feedback.id });
  if (inserted) return { success: true, feedbackId: inserted.id };

  const [existing] = await db
    .select({ id: search_feedback.id })
    .from(search_feedback)
    .where(
      and(
        eq(search_feedback.team_id, identity),
        eq(search_feedback.endpoint, answers.endpoint),
        eq(search_feedback.job_id, answers.jobId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Conflicting keyless feedback was not found");
  return { success: true, feedbackId: existing.id, alreadySubmitted: true };
}
