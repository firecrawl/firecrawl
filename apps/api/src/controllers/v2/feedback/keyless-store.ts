import { and, eq, sql } from "drizzle-orm";
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
  // Serialize submissions for the same job in PostgreSQL so retries remain
  // idempotent even if the deployed table has no matching unique index.
  return db.transaction(async tx => {
    const lockKey = `keyless-feedback:${identity}:${answers.endpoint}:${job.id}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const findExisting = async () => {
      const [existing] = await tx
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
      return existing;
    };
    const existing = await findExisting();
    if (existing)
      return {
        success: true as const,
        feedbackId: existing.id,
        alreadySubmitted: true as const,
      };

    const [inserted] = await tx
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
      .onConflictDoNothing()
      .returning({ id: search_feedback.id });
    if (inserted) return { success: true as const, feedbackId: inserted.id };

    const conflicted = await findExisting();
    if (!conflicted)
      throw new Error("Conflicting keyless feedback was not found");
    return {
      success: true as const,
      feedbackId: conflicted.id,
      alreadySubmitted: true as const,
    };
  });
}
