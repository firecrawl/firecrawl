# Endpoint Selection

Ask this before picking an endpoint:

- **What should Firecrawl do in the product?**

Use the narrowest endpoint that matches the feature:

| Endpoint | Use when | Do not start here when |
|---|---|---|
| `/scrape` | You already have the URL and need one page | The feature starts with a query |
| `/search` | The feature starts with a query and must discover sources | The target URL is already known |
| `/interact` | The page must be clicked, typed into, or navigated after scrape | Plain `/scrape` already returns the data |

Default priority for most product integrations:

1. `/scrape`
2. `/search`
3. `/interact`

Escalation rules:

- Start with `/scrape` before `/interact`.
- Start with `/search` when URL discovery is part of the product behavior.

## Beyond The Three Endpoints

Two Firecrawl indexes sit beside `/scrape`, `/search`, and `/interact`. Neither is queried by `/search`:

| Index | Use when | Reached by |
|---|---|---|
| Research paper index | The query is for published research papers — biomedical, clinical, and life-science literature (PubMed, bioRxiv, medRxiv) or arXiv preprints — rather than web pages | MCP `firecrawl_research_*`, CLI `firecrawl research <subcommand>`. See [firecrawl-research-index](../../firecrawl-research-index/SKILL.md) |
| Developer index | The answer belongs in an issue, merged pull request, README, or documentation page: code behavior, an API contract, an error string, a known bug | `GET` or `POST /v2/search/developer`, MCP `firecrawl_developer_search`, CLI `firecrawl developer`. See [firecrawl-developer-index](../../firecrawl-developer-index/SKILL.md) |

The `categories: ["research"]` and `categories: ["developer"]` options on `/search` are website filters. They restrict an ordinary web search to a short list of domains and return page results from them — the research list includes PubMed, bioRxiv, medRxiv, arXiv, and publisher sites. They reach those sites' web pages but do not query either index, so there is no abstract search, related-paper expansion, or full-text passage retrieval behind them. Choose them when a web search is what the feature wants and those sources should be weighed in the same call.
