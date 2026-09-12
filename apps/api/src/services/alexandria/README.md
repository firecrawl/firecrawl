# Alexandria Search and Scrape

Search discovers tools; Scrape executes them. Both require `exchangeRetrieve`.
Ordinary Search and Scrape keep their existing paths and billing.

```json
{
  "query": "economic indicators",
  "sources": ["web", "alexandria"],
  "domainTools": true
}
```

Search returns contracts in `data.tools`: provider, capability, options,
response schema, pricing, and match provenance. Tool discovery is free;
ordinary web results are still billed. `domainTools: false` disables URL
matching without disabling semantic discovery. Contracts and recorded examples
come from Exchange; this API does not generate SDK snippets.

```json
{
  "exchange": {
    "provider": "fred",
    "capability": "series/observations",
    "options": { "series_id": "GDP", "limit": 1 }
  }
}
```

Scrape accepts one call or up to ten and returns `data.exchange` with
`data.creditsCost`. `/exchange/retrieve` uses the same execution and billing
path. URL scraping and explicit tool execution cannot be combined in one body.
The separate docs/client branches still need their `skills` option renamed
to `domainTools`; this branch does not change those repositories.

## Billing and Recovery

One BullMQ job owns the request, reservation, provider response, and settlement.
The existing index worker consumes the dedicated Alexandria queue; failed jobs
are visible in the existing Bull Board. No SQL migration is required.

1. Verify current organization provider access and agreements on the primary DB.
2. Quote the maximum cost and reserve credits with Autumn. Paid requests fail
   closed if reservation or billing configuration is unavailable.
3. Execute under the existing team concurrency limit, with that budget and a deadline.
4. Finalize actual credits using the original hold and partner token.
5. Record usage through `billTeam7`, then confirm Exchange's usage event.

The request ID is scoped to the authenticated team and bound to the normalized
payload. Concurrent requests and cross-route retries share the same job.
Completed results, including definitive refusals, are retained for seven days.
Use a new ID for a new attempt after an explicit refusal stating no provider
executed. Never use a new ID to retry a timeout or an uncertain outcome.

Checkpoints precede reservation, execution, and the non-idempotent usage insert.
An interrupted operation in one of those phases is retained as a failed job
for manual reconciliation, not automatically executed or debited again.
Handled settlement and reporting failures retry from their checkpoints. A
stalled worker requires review except for idempotent reporting; its old owner
could still resume. Each checkpoint checks the worker's BullMQ lease.
Inspect the job
and Exchange execution history before resolving an ambiguous outcome. Do not
delete the failed job or reset its phase to retry provider execution.

Autumn owns the customer balance; the existing core DB records internal usage.
A usage-write failure does not refund already settled provider work. There is
no claim of an atomic transaction across Autumn, core Postgres, and Exchange.
Failed jobs retain their payload and response until explicitly reconciled.
ZDR provider calls are refused because this workflow retains request state.

## Runtime

Requires the API, index worker, Redis, existing core database, and Exchange.
`FIRE_EXCHANGE_URL` and `EXCHANGE_INTERNAL_SECRET` configure Exchange; billing
reports require HTTPS. Paid execution additionally requires working Autumn
billing. Exchange remains the owner of provider pricing and execution history.
