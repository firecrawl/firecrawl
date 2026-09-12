# Alexandria Search and Scrape

Search discovers tools; Scrape executes them. Both require the
`exchangeRetrieve` flag. Ordinary Search and Scrape keep their paths and billing.

```json
{
  "query": "economic indicators",
  "sources": ["web", "alexandria"],
  "domainTools": true
}
```

Search returns contracts in `data.tools`. Discovery is free and never counts
toward `creditsUsed`; web results are billed as before. `domainTools: false`
disables URL matching only.

```json
{
  "exchange": {
    "provider": "fred",
    "capability": "series/observations",
    "options": { "series_id": "GDP" }
  }
}
```

Scrape accepts one call or up to ten and returns `data.exchange` with
`data.creditsCost`. `/exchange/retrieve` shares the path; its single-call
shape relays a provider error with the Exchange's status and `code`.

## Billing

Inline in the request (`retrieve.ts`): authorize from the Exchange catalog
terms and `organizationDataSourceAccess` flags, quote (`/v1/retrieve/quote`),
reserve with Autumn (`lockCredits`, lock `alexandria_<chargeId>`), execute
`/v1/retrieve` with the budget and deadline headers, settle the receipt
(`finalizeCreditsLock`), enqueue the ledger write on the billing queue with job
id `alexandria-bill-<chargeId>`, and report to `/v1/usage-events/billing`.
Paid requests fail closed when quote, reservation, or `USE_DB_AUTHENTICATION`
is unavailable. No worker, queue, or migration is needed.

## Idempotency

The charge id is `sha256(teamId, x-request-id)`; send `x-request-id` on every
paid request or a retry is a new charge. One Redis record per charge id lives
seven days:

- completed: replays the response, no second execution
- same id, different payload: 409 `duplicate_request`
- still running: 409 `request_in_flight`
- refused before execution (authorization, quote, hold, Exchange 4xx or
  `deadline_exceeded`): hold released, record dropped, same id may retry
- uncertain (Exchange 5xx, timeout, malformed or over-budget receipt, crash
  after the record was written): 503 `request_unresolved`, record kept for
  manual reconciliation, hold expires on its own; the Exchange has no
  request-id idempotency, so this is never re-executed automatically

An unsettled confirm returns the answer, writes no ledger row, and sends no
Exchange confirmation; the run stays pending on the Exchange for
reconciliation. ZDR-forced teams are refused because the record is retained.

## Runtime

API, Redis, Exchange (`FIRE_EXCHANGE_URL`; `EXCHANGE_INTERNAL_SECRET` enables
the usage report) and Autumn for paid execution. Paid settlement is covered
by mocked tests only and has not run against an Autumn sandbox.
