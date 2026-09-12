# Keyless feedback

Eligible keyless callers submit optional evidence through `POST /v2/feedback`. Search, Scrape, and Parse use the same identity and submission limits across API, MCP, and CLI. An API key is not required. The authenticated feedback routes keep their existing request contracts.

A submission requires `endpoint`, `jobId`, `rating` (`good`, `partial`, or `bad`), `task`, `assessment`, and 1-20 `observations`. Task, assessment, and observation detail must each contain 10-2000 characters after trimming. These bounds reject empty or very short answers; they cannot guarantee factual accuracy.

Each observation requires `kind`, `detail`, and `basis`. Use `output` for observations about returned content, `source_comparison` for comparisons already made, and `expectation` for unmet expectations that have not been verified against a source. A source comparison requires `comparison: {reference, detail}`. Do not guess missing content, diagnose root causes, or investigate solely to submit feedback. Unmentioned results are unassessed.

| Endpoint | Observation kinds                                    | Additional evidence                                                                                                         |
| -------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Search   | `useful`, `irrelevant`                               | Required `source`: `web`, `images`, or `news`, and one-based `position` within that delivered group. Positions must exist.  |
| Search   | `missing`                                            | Required `topic`, optional `knownSources` HTTP(S) URLs.                                                                     |
| Scrape   | `correct`, `missing`, `incorrect`, `failure`         | Optional `location` and any already-observed `retryOutcome`. A failure report still requires task intent and an assessment. |
| Parse    | `correct`, `text`, `table`, `layout`, `completeness` | Optional affected `location`, such as a page, table, or section.                                                            |

```json
{
  "endpoint": "search",
  "jobId": "00000000-0000-4000-8000-000000000001",
  "rating": "partial",
  "task": "Find the documented retry behavior",
  "assessment": "The API reference answered the retry question, but the news result did not.",
  "observations": [
    {
      "kind": "useful",
      "source": "web",
      "position": 1,
      "basis": "output",
      "detail": "The reference specifies the retry intervals."
    },
    {
      "kind": "irrelevant",
      "source": "news",
      "position": 1,
      "basis": "output",
      "detail": "The announcement does not discuss retry behavior."
    }
  ]
}
```

## Discovery and clients

Search returns its `id` and optional top-level `metadata`. Scrape and Parse include `jobId` and optional `feedback` in `data.metadata`. Execution failures can include top-level `metadata`. A job reference is scoped to the originating identity and endpoint and expires after 24 hours. Jobs from before this feature was enabled do not have this context.

MCP exposes `firecrawl_feedback`. CLI exposes `firecrawl feedback <endpoint> <jobId> --rating <rating> --task <task> --assessment <assessment> --observations-file <path>`. CLI invitations use stderr, preserving ordinary stdout; JSON results retain metadata. Submitting feedback is optional and does not alter operation allowance.

`KEYLESS_FEEDBACK_ENABLED` controls the keyless feature, default `true`. Feedback also requires database authentication, keyless access, and `KEYLESS_FEEDBACK_REDIS_URL`. `KEYLESS_FEEDBACK_INVITATION_EVERY` invites on every Nth eligible result per identity across Search, Scrape, Parse, and all clients, default `3`; `0` disables invitations while retaining submission support. Context/invitation work adds at most 250 ms of waiting to operation responses and fails without failing the operation. Invitations across all three categories are suppressed after acceptance, during attempt throttling, and when eligibility or storage checks fail. Concurrent operation responses can observe eligibility before another submission commits; the submission endpoint always rechecks the authoritative limit.

Keyless invitation frequency is controlled by the server. Caller headers and client feedback preferences do not suppress eligible invitations. Submitting feedback remains optional and is never required for continued keyless access.

## Limits and storage

One new submission is accepted per identity per UTC day, shared across Search, Scrape, and Parse. A retry for the same job returns the original feedback ID with `alreadySubmitted: true`. All feedback attempts share a separate 10-per-minute limiter. Blocked and invalid keyless identities are rejected using the existing authentication checks. Remaining Search, Scrape, or Parse allowance does not affect feedback eligibility. Feedback does not refund or reset operation quota.

The API retains a bounded job snapshot in Redis for up to 24 hours, including redacted request options and available result context. Credential-named fields and file payloads are excluded. Browser actions retain only their types; form values and scripts are omitted. URL fields omit user information, query strings, and fragments. Output excerpts and free-text request fields remain task content, not guaranteed secret-free text. Search preserves delivered groups, order, result URLs, and serving category tags. Snapshot construction bounds traversal and copies strings before serialization. Request options have a 16 KiB budget and result evidence a 24 KiB budget, with individual strings capped at 16,000 characters and explicit truncation markers. Search preserves delivered positions even when descriptions are truncated. The complete snapshot is bounded to 64 KiB. Zero-retention requests are excluded.

Configure `KEYLESS_FEEDBACK_REDIS_URL` to a separate Redis instance with a memory budget and eviction policy such as `allkeys-lru`. Snapshots and invitation frequency counters use that instance. There is no fallback to `REDIS_RATE_LIMIT_URL` or `REDIS_EVICT_URL`; missing configuration disables feedback storage. The API rejects configurations pointing to the rate-limit server's same hostname and port, including different logical databases. Operators must also avoid different DNS aliases for the same instance. Attempt throttling and operation quotas remain on the rate-limit store; accepted-submission limits remain in PostgreSQL. Cache eviction may end a job's feedback window early, but must not evict quota counters. A cache outage suppresses new invitations and returns a retryable feedback error without failing ordinary operations. Once a job reaches feedback metadata preparation, its reference survives a snapshot or invitation timeout; a reference alone does not guarantee that its context was stored or remains available.

Accepted submissions and snapshots are stored together in the existing `search_feedback` table. `endpoint`, `job_id`, `team_id`, `origin`, and `integration` support filtering. `metadata.version = 'keyless_feedback_v1'` identifies the contract; `metadata.answers` holds the evidence and `metadata.context` holds request options, result context, completion status, and timestamp. Origin and integration are client-reported attribution, not identity or authorization evidence. No new table or review service is required.

Reviewers can query the existing table by category and date, inspect `basis` before treating an observation as source-supported, and retain useful examples for investigation or evaluation:

```sql
SELECT id, endpoint, job_id, origin, integration,
       metadata->'answers' AS answers,
       metadata->'context' AS context
FROM search_feedback
WHERE metadata->>'version' = 'keyless_feedback_v1'
ORDER BY created_at DESC
LIMIT 100;
```

Admission uses a transaction-scoped PostgreSQL advisory lock per identity. The daily check, duplicate check, and insert use the primary database in one transaction. Failed writes roll back without consuming the daily allowance. Redis is used only for attempt throttling, invitations, and expiring job context, not as the accepted-submission ledger.

## Invitation measurement

Contexts start with `invited: false`. When a response containing an invitation finishes, the API emits an INFO-level structured event with `canonicalLog: "keyless/feedback_invitation"`, `invited: true`, `issuedAt`, `identity`, `endpoint`, `jobId`, `origin`, and `integration`. It then updates the cached context to `invited: true` without extending its TTL or recreating evicted data. Responses that time out during invitation preparation or disconnect before completion produce no issuance event. The frequency counter counts eligible opportunities, not issued invitations.

Context and submission failures emit sanitized diagnostic events without request bodies or credentials.

Retain these structured events in the deployment's log store for the reporting period. They include nonresponders and survive context expiry through log retention; counting accepted feedback rows or scanning the expiring cache cannot provide the denominator. Deduplicate events by identity, category, and job ID. Join `jobId` to accepted `search_feedback.job_id` for invited-job response rates. Count unique identities separately from total invitations, and keep unsolicited submissions separate. For a cohort's final response rate, allow its 24-hour feedback window to close.

An issuance event means the API finished writing an invitation-bearing response, not that an agent read it. IP-derived keyless identities are not individual agents. Context updates happen asynchronously after the response and can fail or race with an immediate submission; use issuance events as the measurement source. A failed cache update emits `keyless/feedback_invitation_context_error`. Logging is best effort, so process termination or log delivery loss can undercount issuance. Verify INFO-event collection and retention before interpreting response rates; no exact-delivery guarantee or additional tracking endpoint is introduced.
