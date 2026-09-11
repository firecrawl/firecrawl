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

`KEYLESS_FEEDBACK_ENABLED` controls the keyless feature, default `true` when database authentication and keyless access are configured. `KEYLESS_FEEDBACK_INVITATION_EVERY` invites on every Nth eligible result per identity and category, default `3`; `0` disables invitations while retaining submission support. Context/invitation work adds at most 250 ms of waiting to operation responses and fails without failing the operation. Invitations are suppressed after acceptance, during attempt throttling, and when eligibility or storage checks fail. Concurrent operation responses can observe eligibility before another submission commits; the submission endpoint always rechecks the authoritative limit.

## Limits and storage

One new submission is accepted per identity and category per UTC day. A retry for the same job returns the original feedback ID with `alreadySubmitted: true`. All feedback attempts share a separate 10-per-minute limiter. Blocked and invalid keyless identities are rejected using the existing authentication checks. Remaining Search, Scrape, or Parse allowance does not affect feedback eligibility. Feedback does not refund or reset operation quota.

The API retains a bounded job snapshot in Redis for 24 hours, including redacted request options and available result context. Request credentials and file payloads are excluded. Search preserves delivered groups, order, result URLs, and serving category tags. Document result context is limited to 16,000 characters with explicit truncation. The complete snapshot is bounded to 64 KiB; oversized snapshots are not offered for feedback. Zero-retention requests are excluded.

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

Admission uses a transaction-scoped PostgreSQL advisory lock per identity and category. The daily check, duplicate check, and insert use the primary database in one transaction. Failed writes roll back without consuming the daily allowance. Redis is used only for attempt throttling, invitations, and expiring job context, not as the accepted-submission ledger.
