# Alexandria discovery and provider execution

`POST /v2/search` accepts `"alexandria"` in `sources`, including alongside web,
news and images. Strings and objects can be mixed. Catalogue discovery is free;
web search and subsequent provider execution retain their own charges. The current
team rollout gate still applies. Catalogue access comes from authenticated team
flags, never a caller-supplied access flag or header.

## Search and browse

```json
{
  "query": "podcast episode transcripts",
  "sources": [
    "web",
    {
      "type": "alexandria",
      "mode": "semantic",
      "categories": ["podcasts"],
      "level": "providers",
      "limit": 5
    }
  ]
}
```

Omit `query` for catalogue-only browsing:

```json
{
  "sources": [
    {
      "type": "alexandria",
      "mode": "browse",
      "providers": ["particle"],
      "level": "tools",
      "expand": ["options", "response", "examples"],
      "languages": ["javascript", "python", "curl"],
      "limit": 5
    }
  ]
}
```

- `mode`: `semantic` ranks the query; `browse` lists the filtered catalogue.
  Defaults to semantic with a query and browse without one.
- `categories`, `providers`, `domains`, `groups`, `capabilities`: optional arrays
  of identifiers. Values within a filter are alternatives; different filters
  narrow each other. `retail` maps to the `shopping` category. Domains are
  hostnames, such as `podcasts.apple.com`, and use Exchange's provider mappings.
- `level`: `categories`, `providers` (default), `groups`, or `tools`.
- `expand`: include `options`, `response`, and/or `examples` at the tools level.
  `languages` selects example languages when examples are expanded.
- `limit`: 1–100 items at the selected level. `cursor`: reuse the returned
  `nextCursor` with the same query and filters to fetch the next page.

The response is under `data.alexandria`: `status`, `mode`, `level`, `items`,
`total`, and `nextCursor`. Items contain stable IDs, accessible `toolCount`, and
`next`, a complete `/v2/search` body for expanding that item. Following `next`
browses the selected scope, so a provider can reveal its full matching catalogue.
Tool prices marked `perRecord` are per returned record.

`status: "unavailable"` with `total: null` means discovery failed; it is distinct
from an available catalogue with zero matches. Invalid or stale cursors return 400. Changes to access, the catalogue, or ranking can invalidate a cursor.

Legacy `sources: ["exchange-providers"]` with a query preserves its existing
`data["exchange-providers"]` result shape. Advanced objects using that alias
use the Alexandria envelope. Do not request both aliases together.

## Contextual tools and skill documents

`POST /exchange/skills/resolve` accepts `{ "urls": [...], "query": "..." }`.
`GET /exchange/skills/:id/SKILL.md` returns the Markdown contract. These routes
derive catalogue visibility from authentication; URL lookup rejects forced ZDR.
Provider domains, query terms, selected capabilities and search/scrape placement
remain configured beside the provider's on/off flags in Exchange. See that
repository's `docs/domain-skill-resolver.md` before adding a mapping.

## Credit reservation and retries

Direct `POST /exchange/retrieve` and `/v2/scrape` requests with `exchange` require
`x-request-id`: 1–128 letters, digits, dots, underscores, colons or hyphens. Generate
one ID per logical execution and reuse it for retries of the same payload. A
trusted agent interop request can supply its existing request ID instead.

The API quotes a maximum cost, reserves credits atomically, then executes with
that budget. Insufficient credits return 402 before execution. An unavailable
reservation returns 503. Successful calls confirm only their actual cost, release
the unused balance, and queue the ledger update without charging Autumn twice.
Per-record requests must have a bounded cost, up to 100 credits per call and ten
calls per batch.

Completed responses up to 5 MiB are retained for 24 hours. Reusing an ID with a
different payload returns 409. Concurrent or ambiguous requests cannot execute
again: a 409 awaiting reconciliation must not be retried with a new ID. Responses
too large to retain also return 409 on replay. An uncertain provider outcome or
billing acknowledgement requires operational reconciliation; its hold expires
after one hour if it cannot be confirmed.

Deploy the supporting Exchange catalogue, quote, and budget enforcement before
this API change. Paid hosted execution requires the configured Autumn/firebill
credit-hold service. SDK changes are a follow-up; this change establishes the HTTP
contract.

Generated JavaScript and Python examples call HTTP directly until SDK support is
added, and include the same request-ID contract as cURL. Replace the request-ID
placeholder once per logical operation; keep that value when retrying.
