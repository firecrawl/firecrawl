# Freshness and Liveness

Two separate questions. Keep them separate in code:

- **Freshness** — how old is this content? Controlled by `maxAge`.
- **Liveness** — is the thing the page describes still active? A source-specific
  judgment your application makes from the content.

## `maxAge` and the Cache Tradeoff

Firecrawl reuses recently indexed content, which is what makes repeat reads of
the same URL fast and cheap. `maxAge` is the maximum age, in milliseconds, of an
indexed copy that `/scrape` may return.

- Omit `maxAge` and Firecrawl chooses the window itself, tuning it per domain.
  This is the right default for most reads.
- Set `maxAge` explicitly when the feature has a real staleness bound.
- `maxAge: 0` skips index reuse and takes the live scrape path. It costs
  latency, and it surfaces live-site failures that a reused copy would have
  masked, so spend it on reads where staleness would cause a wrong or costly
  decision.

`/parse` is always uncached: it ignores a client `maxAge` and does not store its
result, so there is no freshness knob to set there.

## Verifying What You Got

From `/scrape` response metadata:

- `cacheState` — `"hit"` or `"miss"`, present only when index reuse was
  eligible. With `maxAge: 0` the field is absent, which is itself the
  confirmation that no indexed copy was used.
- `cachedAt` — ISO timestamp of the reused copy, present on a `"hit"`.
- `sourceURL` — the URL you requested.
- `url` — the URL the response came from. Differing values mean the request was
  redirected. Equal values are not proof that no redirect occurred, because
  `url` falls back to the requested URL when the engine reports none.
- `statusCode` — the HTTP status of the response.

## Deciding Liveness

Firecrawl supplies page evidence; your application interprets it in its own
terms. `200` plus non-empty content means the fetch succeeded, not that the item
described by the page is still active — plenty of sites serve a full page for a
removed record.

- Read the rendered content for the source's own signals.
- Prefer a source-specific API or identifier where one exists. Those usually
  state a status that the rendered page only implies.
- When the evidence is inconclusive, keep the state `unknown` and stop before an
  expensive or irreversible step rather than assuming active.
