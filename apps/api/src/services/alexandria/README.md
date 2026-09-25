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

## Terms acceptance

`firecrawl/terms/accept` (run by the Exchange through `/v1/retrieve`) and
`POST /exchange/provider-terms/accept` write the Exchange ledger. Once the
ledger confirms, `access-record.ts` mirrors the acceptance into
`organization_data_source_access`, the row the dashboard writes, so
`flags.organizationDataSourceAccess` shows it, and clears the auth chunk of
every team of the org. It follows the dashboard's rules: only the current
terms; never re-enables a suspended row or one disabled for any reason but the
org admin's own revocation, which a later acceptance lifts (as
`authorizeProviders` already does); only for an admin's own key, or any key of
the org while it allows agent acceptance. A failed mirror is logged and never
fails the accept, since authorization still honours the ledger.
`POST /admin/$BULL_AUTH_KEY/provider-access-backfill` with
`{ orgIds, dryRun }` (dry run by default) derives rows for acceptances made
before the mirror, or that it failed to write.

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

Bash source loading (`firecrawl/bash` with `options.requestId`) must be sent as a
single-call request. Mixed batches are rejected before billing or dispatch because
caller authorization is request-scoped. Workspace reuse (`options.workspaceId`)
does not forward the caller credential. Exchange consumes the forwarded credential
only in its Bash saved-scrape reader; provider integrations use their own credentials.
