import { and, eq, gte, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "../../../db/connection";
import { search_feedback } from "../../../db/schema";
import type { KeylessFeedbackRequest } from "./keyless-schema";
import type { KeylessFeedbackContext } from "./keyless-context";

const utcDayStart = sql`date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

export async function hasKeylessFeedbackToday(identity: string) {
  const [row] = await db
    .select({ id: search_feedback.id })
    .from(search_feedback)
    .where(
      and(
        eq(search_feedback.team_id, identity),
        gte(search_feedback.created_at, utcDayStart),
      ),
    )
    .limit(1);
  return !!row;
}

export async function insertKeylessFeedback(
  identity: string,
  answers: KeylessFeedbackRequest,
  context: KeylessFeedbackContext,
) {
  return db.transaction(
    async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`keyless-feedback:${identity}`}))`,
      );
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
      if (existing)
        return {
          success: true as const,
          feedbackId: existing.id,
          alreadySubmitted: true,
        };

      // Use the database clock after acquiring the lock, including at UTC midnight.
      const [today] = await tx
        .select({ id: search_feedback.id })
        .from(search_feedback)
        .where(
          and(
            eq(search_feedback.team_id, identity),
            gte(search_feedback.created_at, utcDayStart),
          ),
        )
        .limit(1);
      if (today) return { success: false as const };

      const feedbackId = uuidv7();
      await tx.insert(search_feedback).values({
        id: feedbackId,
        endpoint: answers.endpoint,
        job_id: answers.jobId,
        search_id: answers.endpoint === "search" ? answers.jobId : null,
        team_id: identity,
        overall_rating: answers.rating,
        comment: answers.assessment,
        origin: answers.origin,
        integration: answers.integration ?? null,
        job_status: context.success ? "completed" : "failed",
        metadata: { version: "keyless_feedback_v1", answers, context },
        created_at: sql`clock_timestamp()`,
      });
      return { success: true as const, feedbackId };
    },
    { isolationLevel: "read committed" },
  );
}
