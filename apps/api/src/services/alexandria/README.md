# Alexandria Search and Scrape

Search discovers tools; Scrape executes them. Provider execution enforces
authentication, organization access, provider terms, and billing. Ordinary Search
and Scrape keep their paths and billing.

```json
{
  "query": "economic indicators",
  "sources": ["web", "alexandria"],
  "domainTools": true
}
```

Search returns contracts in `data.tools`, up to `limit` per discovery source
(semantic and domain). Discovery is free and never counts toward
`creditsUsed`; web results are billed as before. `domainTools: false` disables
URL matching only.

```json
{
  "alexandria": {
    "provider": "fred",
    "capability": "series/observations",
    "options": { "series_id": "GDP" }
  }
}
```

An ordinary URL scrape accepts `domainTools: true` (default off) and adds
`data.tools` matched to the page's domain in the same shape as Search. It
requires authentication and no zero data retention, refused with the same 403
Search returns; discovery itself is free and never fails the scrape.

Scrape with `alexandria` accepts one call or up to ten and returns
`data.alexandria` with `data.creditsCost`. `/exchange/retrieve` shares the path; its single-call
shape relays a provider error with Alexandria's status and `code`.

## Billing

Inline in the request (`retrieve.ts`): authorize through Alexandria
(`/v1/provider-terms/requirements`, which refuses unknown providers) against
the organization's `organizationDataSourceAccess` flags, then refuse a
free-plan team (Autumn rate-limit multiplier below the hobby floor) calling a
capability the Exchange lists in `paidPlanOnlyCapabilities` with 403
`paid_plan_required`, or with 503 `plan_verification_unavailable` when the plan
cannot be known (no org, preview team, Autumn error): this read fails closed
where the rate limiter fails open (Benzinga Schedule C.4: full text, WIIM,
analyst ratings), quote
(`/v1/retrieve/quote`), reserve with Autumn (`lockCredits`, lock
`alexandria_<chargeId>`), execute `/v1/retrieve` with the budget and deadline
headers, settle the receipt (`finalizeCreditsLock`), enqueue the ledger write
on the billing queue with job id `alexandria-bill-<chargeId>`, and report to
`/v1/usage-events/billing`. Paid requests fail closed when authorization,
quote, reservation, or `USE_DB_AUTHENTICATION` is unavailable. No worker,
queue, or migration is needed.

## Idempotency

The charge id is `sha256(teamId, x-request-id)`; send `x-request-id` on every
paid request or a retry is a new charge. One Redis record per charge id lives
seven days:

- completed: replays the response and its `scrape_id`, no second execution
- same id, different payload: 409 `duplicate_request`
- still running: 409 `request_in_flight`
- refused before execution (authorization, quote, hold, Exchange 4xx or
  `deadline_exceeded`): hold released, record dropped, same id may retry. A
  release that does not land is logged; that hold expires on its own shortly
  after the request deadline, so a retry may briefly hold credits twice
- uncertain (Exchange 5xx, timeout, malformed or over-budget receipt, crash
  after the record was written): 503 `request_unresolved`, record kept for
  manual reconciliation, hold expires on its own; the Exchange has no
  request-id idempotency, so this is never re-executed automatically

An unsettled confirm returns the answer, writes no ledger row, and sends no
Exchange confirmation; the run stays pending on the Exchange for
reconciliation. A ledger commit or enqueue that fails is refunded at Autumn on
the direct route; on the firebill route the durable charge stands pending
reconciliation. Provider tools do not support forced zero data retention;
those teams are refused before any record is written.

## Runtime

API, Redis, Exchange (`FIRE_EXCHANGE_URL`; a non-blank
`EXCHANGE_INTERNAL_SECRET` enables the usage report) and Autumn for paid
execution. Paid settlement is covered by mocked tests only and has not run
against an Autumn sandbox.

The caller's `Authorization` header is forwarded to Exchange on every execution
request (`/v1/retrieve`), never on quote or authorization requests, and is never
stored. It lets Exchange tools that call Firecrawl on the caller's behalf (the
caller pays) authenticate upstream. Exchange decides which tools read it;
provider integrations use their own credentials.

Bash source loading (`firecrawl/bash` with `options.requestId`), SQL and enrichment
must still be sent as single-call requests. Mixed batches are rejected before billing
or dispatch.
