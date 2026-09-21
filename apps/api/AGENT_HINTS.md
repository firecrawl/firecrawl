# Response guidance for agents

The v2 `POST /search`, `/scrape`, `/parse`, and `/map` routes may return an optional top-level `agent_hints: string[]`. Each response contains at most one result-dependent cross-endpoint suggestion and one low-credit notice. Existing data, errors, warning fields, and HTTP statuses remain unchanged.

Hints are disabled by default. Trusted agent adapters such as the Firecrawl MCP server and CLI can enable them for one request with:

```http
X-Firecrawl-Agent-Hints: true
```

The header applies to the business request. No request-body schema changes are required. SDKs and other adapters should retain the top-level field when unwrapping `data` and should preserve it on error results. The strings recommend conditional next steps; receiving one does not execute another request or indicate user authorization.

## SDK and adapter delivery

The accompanying JavaScript and Python SDK changes preserve `agent_hints` alongside normal flattened Document, SearchData, and MapData results and on typed errors. Python covers synchronous and asynchronous clients. Markdown and HTML retain their existing content.

Raw HTTP and ordinary SDK callers receive no hints unless their adapter explicitly sets the header above. This change does not add a client-wide SDK hint option. The SDK release must precede upgrading pinned CLI/MCP dependencies for their keyed SDK paths to retain the field.

## Initial rules

- Search excerpts: offer Scrape when a web result has no markdown, HTML, or raw HTML. Inspect actual output per result, not the requested scrape setting.
- Empty web search: offer another Search with a broader or alternative query only when a web result collection is explicitly present and empty.
- Search result cluster: when at least four valid HTTP(S) result URLs are present and at least three share one origin representing at least 75% of valid result URLs, offer Map for URL discovery or Crawl for multi-page content.
- Source page 401: when a successful Scrape envelope includes both a page status of 401 and a scrape ID in `metadata.scrapeId` or top-level `scrape_id`, offer Interact using that concrete scrape ID for authentication or page interaction.
- Source page 404/410: offer Search for a current location or alternative. An API cache-miss 404, 429, authentication failure, or timeout does not fire this rule.
- Truncated PDF: when Scrape reports `totalPages > numPages`, offer another Scrape with a higher PDF `maxPages` value, capped at the API maximum of 10,000.
- Low credits: when the authoritative billing preflight reports fewer than 100 credits, ask the agent to let the user know they should add more credits. This notice is independent of endpoint success for responses that reach the hint middleware, and it does not replace a useful cross-endpoint suggestion.

Selection reads only request/response fields and billing state already in memory. It makes no additional network/model calls, reads no additional session/database state, and does not scan page text or classify user intent. No hint appears solely to fill an available slot.

Static feedback instructions do not belong in response hints. Adapters that expose a feedback tool should document its contract in the relevant tool descriptions, where the guidance is available before invocation and can reference the adapter's actual feedback tool and identifiers.

## Validation

The focused selector tests exercise excerpt detection, source-page failures, error suppression, the low-credit threshold, and combined hints. Express route fixtures exercise response preservation, opt-in, opt-out, low-credit delivery, and responses without a useful next step. Hosted snips cover a completed scrape, map opt-out, and validation failure through the actual API. The snips use the harness and existing test service; they are not a live paid API smoke test.
