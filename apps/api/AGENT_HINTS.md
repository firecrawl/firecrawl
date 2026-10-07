# Response guidance for agents

The v2 `POST /search`, `/scrape`, `/parse`, and `/map` routes may return an optional top-level `agent_hints: string[]`. Each response contains at most one result-dependent cross-endpoint suggestion and one low-credit notice. Existing data, errors, warning fields, and HTTP statuses remain unchanged.

Hints are disabled by default. Trusted agent adapters such as the Firecrawl MCP server and CLI can enable them for one request with:

```http
X-Firecrawl-Agent-Hints: true
```

Search and scrape suggestions name the Firecrawl tools (`firecrawl_search`, `firecrawl_scrape`) rather than REST paths, since hints are only requested by the Firecrawl MCP server and CLI. Map, Crawl and Interact suggestions keep their REST paths. Result and redirect URLs inside hints are rendered as JSON-quoted, percent-encoded http(s) hrefs, capped at 200 characters, and labelled by the result's `position` when present.

The header applies to the business request. No request-body schema changes are required. SDKs and other adapters should retain the top-level field when unwrapping `data` and should preserve it on error results. The strings recommend conditional next steps; receiving one does not execute another request or indicate user authorization.

## SDK and adapter delivery

The accompanying JavaScript and Python SDK changes preserve `agent_hints` alongside normal flattened Document, SearchData, and MapData results and on typed errors. Python covers synchronous and asynchronous clients. Markdown and HTML retain their existing content.

Raw HTTP and ordinary SDK callers receive no hints unless their adapter explicitly sets the header above. This change does not add a client-wide SDK hint option. The SDK release must precede upgrading pinned CLI/MCP dependencies for their keyed SDK paths to retain the field.

## Built-in rules

These rules apply when no provider rules are available (no provider configured, the lookup has not finished, or the provider returned no rules). When a provider supplies rules, they replace this list; see [Response guidance rules](#response-guidance-rules).

- Search excerpts: offer Scrape when a web result has no markdown, HTML, or raw HTML. Inspect actual output per result, not the requested scrape setting. The hint names the excerpt-only results by 1-based position and URL (at most three, then a count of the rest), so the agent can choose which to scrape.
- Empty web search: offer another Search with a broader or alternative query only when a web result collection is explicitly present and empty.
- Search result cluster: for authenticated callers only, when at least four valid HTTP(S) result URLs are present and at least three share one origin representing at least 75% of valid result URLs, offer Map for URL discovery or Crawl for multi-page content. Keyless Search callers cannot use Map or Crawl, so they receive no cluster suggestion.
- Source page 401: when database authentication is enabled and a successful Scrape envelope includes both a page status of 401 and a scrape ID in `metadata.scrapeId` or top-level `scrape_id`, offer Interact using that concrete scrape ID for authentication or page interaction. Self-hosted deployments without database authentication do not receive this suggestion because Interact returns 501 there.
- Source page 404/410: offer Search for a current location or alternative. The suggested query is prefilled as `site:<host>` plus words from the last two path segments of the final URL (file extensions, numeric and opaque IDs dropped), with a placeholder when no usable URL is present. When `metadata.sourceURL` and `metadata.url` differ, the hint names the redirect that led to the dead page. An API cache-miss 404, 429, authentication failure, or timeout does not fire this rule.
- Truncated PDF: when Scrape reports `totalPages > numPages`, offer another Scrape only when its PDF `maxPages` can be raised, capped at the API maximum of 10,000.
- Low credits: when the authoritative billing preflight reports fewer than 100 credits, ask the agent to let the user know they should add more credits. This notice is independent of endpoint success for responses that reach the hint middleware, appears before any cross-endpoint suggestion, and does not replace that suggestion.

Selection reads only request/response fields and billing state already in memory. It makes no additional network/model calls, reads no additional session/database state, and does not scan page text or classify user intent. No hint appears solely to fill an available slot.

Static feedback instructions do not belong in response hints. Adapters that expose a feedback tool should document its contract in the relevant tool descriptions, where the guidance is available before invocation and can reference the adapter's actual feedback tool and identifiers.

## Validation

The focused selector tests exercise excerpt detection, source-page failures, error suppression, the low-credit threshold, and combined hints. Express route fixtures exercise response preservation, opt-in, opt-out, low-credit delivery, and responses without a useful next step. Hosted snips cover a completed scrape, map opt-out, and validation failure through the actual API. The snips use the harness and existing test service; they are not a live paid API smoke test.

## Optional external provider

A deployment can supply response guidance from a separate HTTP service: finished hints and response guidance rules. This is disabled unless `AGENT_HINTS_PROVIDER_URL` is set; with it unset, responses use the built-in rules only.

| Variable                             | Default            | Purpose                                                                               |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------- |
| `AGENT_HINTS_PROVIDER_URL`           | unset              | Provider endpoint (http or https). Empty means unset.                                 |
| `AGENT_HINTS_PROVIDER_SECRET`        | unset              | Sent as `Authorization: Bearer <secret>` when set.                                    |
| `AGENT_HINTS_PROVIDER_TIMEOUT_MS`    | `50`               | Per-lookup timeout.                                                                   |
| `AGENT_HINTS_PROVIDER_PSEUDONYM_KEY` | per-process random | Keys the keyless `team_id` pseudonym (at least 32 chars). Never sent to the provider. |

For hint-enabled requests with an authenticated team, the API starts a lookup right after authentication and continues without waiting. Provider hints and rules are used only if the lookup has already finished (or is cached) when the response is sent, so the provider never adds latency. An answer that arrives after the response was sent, but within the timeout, is cached for the next request.

Request:

```http
POST {AGENT_HINTS_PROVIDER_URL}
Authorization: Bearer {AGENT_HINTS_PROVIDER_SECRET}
Content-Type: application/json

{
  "version": 2,
  "team_id": "string (keyless callers: keyless_<64 hex chars>)",
  "org_id": "string | null",
  "api_key_id": "number | null",
  "endpoint": "search | scrape | parse | map",
  "surface": "api | mcp | cli",
  "keyless": false
}
```

No request or response content, URLs, queries, IP addresses, or API keys are sent. Keyless callers have no account team, so `team_id` is a pseudonym instead: `keyless_` followed by the hex HMAC-SHA256 of the internal keyless team ID, keyed by `AGENT_HINTS_PROVIDER_PSEUDONYM_KEY`. That key is separate from `AGENT_HINTS_PROVIDER_SECRET` and is never sent, so the provider cannot recompute pseudonyms from client addresses. Set it to the same value on every API process for pseudonyms that are stable across processes; when unset, each process uses a random key, so pseudonyms are stable only within a process.

Response (`200` only):

```json
{
  "hints": [
    { "id": "string, at most 64 chars", "text": "string, at most 500 chars" }
  ],
  "rules": [
    {
      "id": "string, at most 64 chars",
      "group": "optional string, at most 64 chars",
      "when": [{ "signal": "page_status", "op": "eq", "value": 404 }],
      "text": "string with {signal} placeholders, at most 500 chars"
    }
  ],
  "ttl_seconds": 60
}
```

`rules` is optional; providers that return only `hints` keep working. Requests carry `version: 2`, so a provider that rejects versions it does not know must accept version 2 before the API is upgraded; until then its lookups fail open (no provider hints or rules).

- Any other status, a timeout, a network error, a body larger than 64 KiB, or a body without a `hints` array means no provider hints, cached for 30 seconds. Requests never fail because of the provider.
- `ttl_seconds` defaults to 60 and is clamped to 0–600. Unknown fields are ignored.
- Each hint is trimmed and has control characters replaced; hints with a missing or oversized `id` or `text` are dropped.
- Provider hints are added only to successful (`success: true`) responses. They follow the rule hints (provider rules, or the built-in rules when there are none) and never replace them. Exact duplicates are dropped, at most two provider hints are added, and the total is capped at three.
- Results are cached in memory per process, keyed by team, endpoint, and surface, with one lookup in flight per key and at most 10,000 entries. Different API processes may serve different provider hints until their entries expire.
- Served provider hint IDs are logged with the same `team_id` the provider receives; they are not added to the response. Lookups are counted in `firecrawl_agent_hints_provider_requests_total{outcome="hit|miss|timeout|error|disabled"}`.

## Response guidance rules

A provider can return `rules` instead of finished text. The API evaluates them locally against [signals](#signals) computed from its own response and request state, so response content, URLs and origins never leave the API; the provider only receives the request fields above.

- Rules are evaluated in order. A rule fires when every condition in `when` holds; an empty `when` always holds.
- Conditions compare one signal to a value with `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in` (value is a list), or `exists` (value is a boolean). A condition on an absent signal holds only for `exists: false`. Comparison operators never match list signals, and `lt`/`lte`/`gt`/`gte` only match numbers.
- Rules sharing a `group` are alternatives: the first rule in the group whose conditions hold is the group's rule, and the rest of the group is skipped. If that rule's text needs a signal that is absent, the group emits nothing.
- `text` may contain `{signal}` placeholders. List signals render joined with `, `, and also accept `{signal:first=N}` (the first N items) and `{signal:remaining=N}` (the number of items after the first N), where N is at most 100. A rule whose text references an absent signal, uses a modifier on a non-list signal, or uses N above 100 emits nothing. Text without a matching placeholder pattern, such as JSON `{"url": ...}`, is left as is.
- Rendered texts are deduplicated and capped at three, in rule order. They are evaluated for every response that reaches the hint middleware, including failure envelopes, so rules that only apply to successful responses should include `{ "signal": "success", "op": "eq", "value": true }`.
- Each rule is validated on receipt: an invalid id, group or text, any malformed condition, more than 16 conditions, or an `in` list of more than 32 values drops that rule as a whole. Only the first 32 valid rules are kept.

### Signals

| Signal                       | Type        | Present when                                                                                                                        |
| ---------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`                   | string      | Always: `search`, `scrape`, `parse` or `map`.                                                                                       |
| `success`                    | boolean     | Always: the response envelope has `success: true`.                                                                                  |
| `can_use_map_and_crawl`      | boolean     | Always: the caller is an account team.                                                                                              |
| `can_use_interact`           | boolean     | Always: database authentication is enabled.                                                                                         |
| `remaining_credits`          | number      | The billing preflight reported a finite remaining balance.                                                                          |
| `page_status`                | number      | `data.metadata.statusCode` is a number.                                                                                             |
| `scrape_id`                  | string      | `data.metadata.scrapeId` or top-level `scrape_id` is a non-empty string; URL-path encoded.                                          |
| `page_redirect_from`         | string      | `metadata.sourceURL` and `metadata.url` are different http(s) URLs of at most 200 characters; the source, JSON-quoted.              |
| `page_redirect_to`           | string      | As above; the final URL, JSON-quoted.                                                                                               |
| `page_host`                  | string      | The final (or else source) URL is http(s); its hostname.                                                                            |
| `page_path_words`            | string      | Words from the last two path segments of that URL, with file extensions and numeric or opaque ids dropped; absent when none remain. |
| `document_pages_returned`    | number      | `metadata.numPages` is a finite number.                                                                                             |
| `document_pages_total`       | number      | `metadata.totalPages` is a finite number.                                                                                           |
| `document_max_pages`         | number      | Both page counts are present: the total, capped at the PDF parser maximum of 10,000.                                                |
| `document_pages_requestable` | number      | Both page counts are present: `document_max_pages` minus `document_pages_returned`, at least 0.                                     |
| `result_count`               | number      | A web result collection (`data` array or `data.web`) is present.                                                                    |
| `excerpt_count`              | number      | Web results are present: results with a string `url` and no `markdown`, `html` or `rawHtml`.                                        |
| `excerpt_share`              | number      | At least one web result: `excerpt_count / result_count`.                                                                            |
| `excerpt_results`            | string list | Web results are present: each excerpt as `#<position>` plus its JSON-quoted URL when it is http(s) and at most 200 characters.      |
| `origin_result_count`        | number      | Web results are present: results with a valid http(s) URL.                                                                          |
| `top_origin`                 | string      | At least one valid result URL: the origin with the most results (earliest on ties).                                                 |
| `top_origin_count`           | number      | As above: that origin's result count.                                                                                               |
| `top_origin_share`           | number      | As above: `top_origin_count / origin_result_count`.                                                                                 |
