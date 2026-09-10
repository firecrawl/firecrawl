# Alexandria discovery and provider execution

`POST /v2/search` accepts `"alexandria"` in `sources`, including alongside web,
news and images. Strings and objects can be mixed. Catalogue discovery is free;
web search and subsequent provider execution retain their own charges. The current
team rollout gate still applies. Catalogue access comes from authenticated team
flags, never a caller-supplied access flag or header.

## Semantic search with tool contracts

```json
{
  "query": "podcast conversations about AI agents",
  "sources": ["web", "alexandria"],
  "limit": 5
}
```

A query is required. Semantic matching is implicit for `alexandria`; there are no
browse, level, expand, filter, language, or cursor controls on this source.
`{ "type": "alexandria" }` is equivalent to the string form. The old
`exchange-providers` source retains its compact legacy response.

Web pages appear in `data.web`. Tool matches appear alongside them in
`data.alexandria.items`, in semantic relevance order. Each match includes:

- `provider`, `capability`, `name`, `description`, `concept`, `cohorts`, `similarity`.
- `creditsCost` and `perRecord` for a subsequent provider execution.
- `options` and, where declared, `requiresOneOf` from the actual input contract.
- `response`, containing the actual response contract.
- `examples`: JavaScript, Python and cURL requests generated from the contract.
- `example` only when the provider has a recorded request and response.

Discovery itself costs no credits and never executes provider tools. The endpoint
uses existing Exchange semantic discovery and fetches each selected contract,
with at most four contract reads in flight and one shared discovery deadline.
Results are capped at the semantic index's current limit of 24 tools.

The envelope retains `status`, `mode: "semantic"`, `level: "tools"`, `items`,
`total` (returned tool count), and `nextCursor: null`. This is a ranked search,
not paginated catalogue browsing. `status: "unavailable"` means search or contract
loading failed; it is distinct from an available result with zero matches.

## Find Tools and progressive disclosure

Use the zero-credit meta tool through `POST /exchange/retrieve`:

```json
{
  "provider": "firecrawl-contextual-discovery",
  "capability": "discovery/context",
  "options": { "urls": ["https://open.spotify.com/show/example"] }
}
```

It supports URLs, categories, providers, groups, and capabilities. Follow each
item's `next` retrieval request to reveal groups, tools, and contracts. Its
pagination and expansion options belong to this tool, not to search sources.
See Exchange's `docs/contextual-discovery.md` for the complete contract.

Search's existing opt-in `skills: true` returns contextual matches in `data.skills`.
The web app can associate them with result URLs and display adjacent tools.
The existing `/exchange/skills/resolve` and `/exchange/skills/:id/SKILL.md` proxy
routes remain available. Scrape's web UI does a separate contextual lookup;
this change does not add tool metadata to scrape API responses.

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

Completed responses up to 5 MiB are retained for 24 hours. Pending request identities and reconciliation records do not expire automatically. Reusing an ID with a
different payload returns 409. Concurrent or ambiguous requests cannot execute
again: a 409 awaiting reconciliation must not be retried with a new ID. Responses
too large to retain also return 409 on replay. An uncertain provider outcome or billing acknowledgement leaves a pending record with the request, hold, actual charge (when known), and billing receipt for operational reconciliation. It is not marked complete or allowed to execute again. Holds still expire after one hour, so operators must reconcile unresolved charges; no automatic reconciliation worker is included here.

Deploy the supporting Exchange quote and budget enforcement before paid
execution from this API branch. Semantic search uses the existing discovery
routes; contextual lookup requires the merged discovery meta tool. Paid hosted execution requires the configured Autumn/firebill
credit-hold service. SDK changes are a follow-up; this change establishes the HTTP
contract.

Generated JavaScript and Python examples call `/v2/scrape` with an `exchange` request through HTTP directly until SDK support is
added, and include the same request-ID contract as cURL. Replace the request-ID
placeholder once per logical operation; keep that value when retrying.
