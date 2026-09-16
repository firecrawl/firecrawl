# Response guidance for agents

The v2 `POST /search`, `/scrape`, `/parse`, and `/map` routes may return an optional top-level `agent_hints: string[]`. Each response contains at most three hints: one cross-endpoint suggestion, one distinct result-specific step, and a feedback request when the receiver supports the completed operation. Existing data, errors, warning fields, tool definitions, and HTTP statuses remain unchanged.

Clients can suppress all hints for one request with:

```http
X-Firecrawl-Agent-Hints: false
```

The header applies to the business request. No request-body schema changes are required. SDKs and other adapters should retain the top-level field when unwrapping `data` and should preserve it on error results. The strings recommend conditional next steps; receiving one does not execute another request or indicate user authorization.

## SDK and adapter delivery

The accompanying JavaScript and Python SDK changes preserve `agent_hints` alongside normal flattened Document, SearchData, MapData, AlexandriaScrapeData, and FindToolsData results and on typed errors. Python covers synchronous and asynchronous clients. Markdown, HTML, and provider records retain their existing content.

Raw HTTP callers can opt out with the header above. This change does not add a client-wide SDK hint option; applications can omit the metadata when passing results to a model. The SDK release must precede upgrading pinned CLI/MCP dependencies for their keyed SDK paths to retain the field.

## Initial rules

- Search/Scrape tool definitions: inspect tools that support the caller's task and execute through `/v2/scrape` using the documented inputs. Tool presence or a domain match does not establish relevance.
- Search excerpts: offer Scrape when a web result has no markdown, HTML, or raw HTML. Inspect actual output per result, not the requested scrape setting.
- Alexandria catalogue summaries: use the selected item's existing `next` call to obtain full definitions. Complete definitions do not trigger another expansion.
- Alexandria catalogue continuation: follow the page's `next` only if more tools are needed. Provider-record pagination is not inferred from arbitrary `next` fields.
- Empty catalogue with no continuation: offer web Search for the remaining need, without claiming the entire catalogue lacks a suitable provider.
- Source page 404/410: offer Search for a current location or alternative. An API cache-miss 404, 429, authentication failure, or timeout does not fire this rule.
- Typed Find Tools `invalid_option` rejecting a free-text `query`: direct it to `/v2/search` with the `alexandria` source. Other errors retain their original error information without speculative recovery advice.

Selection reads only request/response fields already in memory. It makes no network/model calls, reads no session/database state, and does not scan page text or classify user intent. No hint appears solely to fill an available slot. Feedback remains independent of cross-product promotion.

## Feedback eligibility

Controllers explicitly identify completed jobs supported by `/v2/feedback`: ordinary Search, Scrape, Parse, and Map. The hint gives the endpoint discriminator, actual job ID, accepted rating values, and substantive evidence requirements. Search includes its configured submission window and rating-specific validation requirements. The agent must choose its own honest rating after assessing the result.

Feedback hints are omitted for database-authentication-disabled deployments, preview teams, opted-out teams, zero-data-retention operations, unsuccessful responses, and paths without an explicitly registered feedback job. This version does not change feedback acceptance policy or persistence.

Alexandria execution currently persists request/billing records rather than a row accepted by the feedback receiver's `scrapes` lookup. Its `scrape_id` is therefore **not** advertised as a valid feedback ID. Adding Alexandria feedback requires explicit receiver/persistence work. Feedback and status-polling routes are not decorated, avoiding recursive or per-poll feedback requests. Existing receiver idempotency applies to repeated submissions for the same endpoint/job.

## Validation

The focused selector tests exercise mixed tools/content, incomplete versus full definitions, catalogue paging, empty results, invalid Find Tools queries, error suppression, and the hint cap. Express route fixtures exercise response preservation, opt-out, feedback eligibility and unpersisted Alexandria IDs. Hosted snips cover a completed scrape, map opt-out, and validation failure through the actual API. The snips use the harness and existing test service; they are not a live paid API smoke test.
