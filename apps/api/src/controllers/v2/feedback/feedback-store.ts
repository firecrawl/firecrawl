import { and, eq } from "drizzle-orm";
import { db, dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { EndpointFeedbackEndpoint } from "../types";
import {
  FeedbackJobRow,
  FeedbackRecordOptions,
  RefundPolicySnapshot,
} from "./internal-types";

type DbError = { code?: string } & Record<string, unknown>;

type ExistingFeedback = {
  id: string;
  credits_refunded: number | null;
};

const JOB_TABLES = {
  search: schema.searches,
  scrape: schema.scrapes,
  parse: schema.parses,
  map: schema.maps,
} as const;

function feedbackMetadata(
  options: FeedbackRecordOptions,
): Record<string, unknown> {
  return {
    ...(options.feedback.metadata ?? {}),
    ...(options.feedback.url ? { url: options.feedback.url } : {}),
    ...(options.feedback.pageNumbers
      ? { pageNumbers: options.feedback.pageNumbers }
      : {}),
  };
}

export async function lookupFeedbackJob(
  endpoint: EndpointFeedbackEndpoint,
  jobId: string,
  dbTeamId: string,
): Promise<FeedbackJobRow | null> {
  const table = JOB_TABLES[endpoint] as any;
  const [row] = await dbRr
    .select({
      id: table.id,
      request_id: table.request_id,
      team_id: table.team_id,
      credits_cost: table.credits_cost,
      created_at: table.created_at,
      options: table.options,
      ...(endpoint === "map" ? {} : { is_successful: table.is_successful }),
    })
    .from(table)
    .where(and(eq(table.id, jobId), eq(table.team_id, dbTeamId)))
    .limit(1);

  if (!row) return null;

  return {
    endpoint,
    id: row.id,
    request_id: row.request_id ?? null,
    team_id: row.team_id,
    credits_cost: row.credits_cost ?? 0,
    created_at: row.created_at,
    is_successful: endpoint === "map" ? true : (row.is_successful ?? null),
    options: row.options ?? null,
  };
}

export async function insertFeedback(params: {
  feedbackId: string;
  options: FeedbackRecordOptions;
  job: FeedbackJobRow;
  dbTeamId: string;
  apiKeyId?: number | null;
}): Promise<DbError | null> {
  const { feedbackId, options, job, dbTeamId, apiKeyId } = params;
  try {
    await db.insert(schema.search_feedback).values({
      id: feedbackId,
      search_id: options.endpoint === "search" ? options.jobId : null,
      endpoint: options.endpoint,
      job_id: options.jobId,
      request_id: job.request_id,
      api_version: "v2",
      team_id: dbTeamId,
      api_key_id: apiKeyId ?? null,
      overall_rating: options.feedback.rating,
      issue_types: options.feedback.issues ?? [],
      tags: options.feedback.tags ?? [],
      comment: options.feedback.note ?? null,
      valuable_sources: options.feedback.valuableSources ?? [],
      missing_content: options.feedback.missingContent ?? [],
      query_suggestions: options.feedback.querySuggestions ?? null,
      metadata: feedbackMetadata(options),
      job_status: job.is_successful === false ? "failed" : "completed",
      credits_billed: job.credits_cost ?? 0,
      credits_refunded: 0,
      refund_policy: null,
      integration: options.feedback.integration ?? null,
      origin: options.feedback.origin ?? null,
    });
    return null;
  } catch (error) {
    return error as DbError;
  }
}

async function findFeedbackByJob(
  dbTeamId: string,
  endpoint: EndpointFeedbackEndpoint,
  jobId: string,
): Promise<ExistingFeedback | null> {
  const [row] = await dbRr
    .select({
      id: schema.search_feedback.id,
      credits_refunded: schema.search_feedback.credits_refunded,
    })
    .from(schema.search_feedback)
    .where(
      and(
        eq(schema.search_feedback.team_id, dbTeamId),
        eq(schema.search_feedback.endpoint, endpoint),
        eq(schema.search_feedback.job_id, jobId),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function findSearchFeedbackByLegacyId(
  dbTeamId: string,
  searchId: string,
): Promise<ExistingFeedback | null> {
  const [row] = await dbRr
    .select({
      id: schema.search_feedback.id,
      credits_refunded: schema.search_feedback.credits_refunded,
    })
    .from(schema.search_feedback)
    .where(
      and(
        eq(schema.search_feedback.team_id, dbTeamId),
        eq(schema.search_feedback.search_id, searchId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function findExistingFeedback(
  dbTeamId: string,
  endpoint: EndpointFeedbackEndpoint,
  jobId: string,
): Promise<ExistingFeedback | null> {
  return (
    (await findFeedbackByJob(dbTeamId, endpoint, jobId)) ??
    (endpoint === "search"
      ? await findSearchFeedbackByLegacyId(dbTeamId, jobId)
      : null)
  );
}

export async function updateFeedbackRefundDetails(
  feedbackId: string,
  creditsRefunded: number,
  policy: RefundPolicySnapshot,
): Promise<DbError | null> {
  try {
    await db
      .update(schema.search_feedback)
      .set({
        credits_refunded: creditsRefunded,
        refund_policy: policy,
        updated_at: new Date().toISOString(),
      })
      .where(eq(schema.search_feedback.id, feedbackId));
    return null;
  } catch (error) {
    return error as DbError;
  }
}
