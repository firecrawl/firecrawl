import { and, eq } from "drizzle-orm";
import { db, dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { EndpointFeedbackEndpoint } from "../types";
import type { SearchResultType } from "../../../lib/entities";
import {
  FeedbackJobRow,
  FeedbackRecordOptions,
  RefundPolicySnapshot,
  ValuableResultInput,
} from "./internal-types";

type DbError = { code?: string } & Record<string, unknown>;

type ExistingFeedback = {
  id: string;
  credits_refunded: number | null;
};

type ValuableResultDocument = {
  documentId: string;
  searchId: string;
  /** The `data` group the client addressed, as sent: web | images | news. */
  requestedSource: SearchResultType;
  /** Analytics spelling, as used in `documentId`. */
  resultType: SearchResultDocumentType;
  resultIndex: number;
  position: number;
  reason?: string;
  source: "position";
};

/**
 * Result type as recorded in analytics. The API groups image results under
 * `images` (matching `data.images`), but the ClickHouse `search_results` table
 * writes the singular `image`; document IDs use the analytics spelling so they
 * join directly on (search_id, result_type, result_index).
 */
type SearchResultDocumentType = "web" | "news" | "image";

const RESULT_DOCUMENT_TYPES: Record<
  SearchResultType,
  SearchResultDocumentType
> = {
  web: "web",
  news: "news",
  images: "image",
};

function searchFeedbackResultDocumentId(
  searchId: string,
  resultType: SearchResultDocumentType,
  resultIndex: number,
): string {
  return `search:${searchId}:${resultType}:${resultIndex}`;
}

/**
 * Number of results in each `data` group, read from the persisted per-source
 * counts. Returns null when the row predates `num_results_by_source` or carries
 * an unrecognised shape, so callers fall back to a looser bound rather than
 * silently treating every group as empty.
 */
function resultCountsBySource(
  job: FeedbackJobRow,
): Partial<Record<SearchResultType, number>> | null {
  const counts = job.num_results_by_source;
  if (counts === null || counts === undefined || typeof counts !== "object") {
    return null;
  }

  const entries = Object.entries(counts as Record<string, unknown>).filter(
    (entry): entry is [SearchResultType, number] =>
      entry[0] in RESULT_DOCUMENT_TYPES &&
      typeof entry[1] === "number" &&
      Number.isInteger(entry[1]) &&
      entry[1] >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * Highest 1-indexed position addressable in `data[source]`, or null when the
 * job row carries no usable bound.
 *
 * Prefers the exact per-source count. Rows written before that column existed
 * fall back to the request's `limit` — every group is sliced to `limit`
 * independently in `search/execute.ts`, so it bounds each group even though the
 * combined `num_results` does not.
 */
function maxResultPosition(
  job: FeedbackJobRow,
  source: SearchResultType,
): number | null {
  const counts = resultCountsBySource(job);
  if (counts !== null) return counts[source] ?? 0;

  const numResults =
    typeof job.num_results === "number" &&
    Number.isInteger(job.num_results) &&
    job.num_results >= 0
      ? job.num_results
      : null;
  if (numResults === null) return null;

  const limit = (job.options as { limit?: unknown } | null)?.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    return numResults;
  }
  return Math.min(numResults, limit);
}

function valuableResultDocuments(
  job: FeedbackJobRow,
  results: ValuableResultInput[] | undefined,
): ValuableResultDocument[] {
  if (job.endpoint !== "search" || !results?.length) return [];

  // Rejects hallucinated positions, which would otherwise be stored as
  // false-positive relevance labels. Zero is a real bound: a group that
  // returned nothing — or was never requested — has no valuable positions.
  const maxPositions = new Map<SearchResultType, number | null>();
  const seen = new Set<string>();

  return results.flatMap(({ source, position, reason }) => {
    if (!(source in RESULT_DOCUMENT_TYPES)) return [];
    if (!Number.isInteger(position) || position <= 0) return [];

    if (!maxPositions.has(source)) {
      maxPositions.set(source, maxResultPosition(job, source));
    }
    const maxPosition = maxPositions.get(source) ?? null;
    if (maxPosition !== null && position > maxPosition) return [];

    const key = `${source}:${position}`;
    if (seen.has(key)) return [];
    seen.add(key);

    const resultType = RESULT_DOCUMENT_TYPES[source];
    const resultIndex = position - 1;
    return [
      {
        documentId: searchFeedbackResultDocumentId(
          job.id,
          resultType,
          resultIndex,
        ),
        searchId: job.id,
        requestedSource: source,
        resultType,
        resultIndex,
        position,
        ...(reason ? { reason } : {}),
        source: "position" as const,
      },
    ];
  });
}

const JOB_TABLES = {
  search: schema.searches,
  scrape: schema.scrapes,
  parse: schema.parses,
  map: schema.maps,
} as const;

function feedbackMetadata(
  options: FeedbackRecordOptions,
  valuableResultDocs: ValuableResultDocument[],
): Record<string, unknown> {
  return {
    ...(options.feedback.metadata ?? {}),
    ...(options.feedback.url ? { url: options.feedback.url } : {}),
    ...(options.feedback.pageNumbers
      ? { pageNumbers: options.feedback.pageNumbers }
      : {}),
    ...(valuableResultDocs.length > 0
      ? {
          // Echoed back in the vocabulary the client sent, not the analytics
          // spelling used in the document IDs.
          valuableResults: valuableResultDocs.map(doc => ({
            source: doc.requestedSource,
            position: doc.position,
          })),
          valuableResultDocumentIds: valuableResultDocs.map(
            doc => doc.documentId,
          ),
        }
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
      ...(endpoint === "search"
        ? {
            num_results: table.num_results,
            num_results_by_source: table.num_results_by_source,
          }
        : {}),
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
    num_results: endpoint === "search" ? (row.num_results ?? null) : null,
    num_results_by_source:
      endpoint === "search" ? (row.num_results_by_source ?? null) : null,
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
  const valuableResultDocs = valuableResultDocuments(
    job,
    options.feedback.valuableResults,
  );
  const valuableSources = [
    ...(options.feedback.valuableSources ?? []),
    ...valuableResultDocs,
  ];

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
      valuable_sources: valuableSources,
      missing_content: options.feedback.missingContent ?? [],
      query_suggestions: options.feedback.querySuggestions ?? null,
      metadata: feedbackMetadata(options, valuableResultDocs),
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
