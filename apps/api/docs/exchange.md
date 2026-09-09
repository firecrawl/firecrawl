# Exchange search and retrieval

Both sources require the team's existing `exchangeRetrieve` permission.

## Search

`POST /v2/search` accepts source names or source objects:

```json
{
  "query": "government funding opportunities",
  "sources": ["web", "exchange", "exchange-provider"]
}
```

- `data.exchange` contains indexed content previews, including the canonical
  `address`, title, description, and retrieval price in `credits`.
  A source `url` can be null for uploaded documents.
- `data["exchange-provider"]` contains provider capabilities that can answer
  the query.
- Exchange discovery does not fetch the full record or run provider capabilities.
  Existing web search and threat-scan charges still apply.
- An unavailable Exchange source is omitted. An available source with no matches
  returns an empty array.

This PR changes the pre-release `exchange` source from capability discovery to
content discovery. Clients seeking capabilities must use `exchange-provider`.

## Call a provider

`POST /v2/scrape`:

```json
{
  "exchange": {
    "provider": "financial-datasets",
    "capability": "prices/latest",
    "options": { "ticker": "NVDA" }
  }
}
```

Existing arrays of 1–10 provider calls remain supported. Results remain in
`data.exchange`, an array, with the total in `data.creditsCost`.

## Fetch indexed content

Use the exact `address` returned by content discovery:

```json
{
  "exchange": {
    "url": "firecrawl://exchange/website/pages/record-id",
    "maxCredits": 3
  }
}
```

`maxCredits` is required and is the maximum accepted charge. If the actual price
exceeds it, the request returns 409 without delivering content or charging the
team. A null discovery price is unknown, not free; set a budget explicitly.

Record fetches accept one canonical address per request. They cannot be mixed
into provider batches. A successful response uses the same `data.exchange`
array envelope, with the retrieved record under the entry's `data`.
Billing authorization and queueing must succeed before content is returned;
the billing queue confirms the access event after the debit.
