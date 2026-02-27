# Firecrawl → RAGFlow Integration

A data-source connector that lets [RAGFlow](https://github.com/infiniflow/ragflow) users pull web content directly through [Firecrawl](https://firecrawl.dev)'s scraping and crawling APIs.

## What it does

- Implements RAGFlow's `LoadConnector` and `PollConnector` interfaces so Firecrawl shows up as a native data source.
- **Scrape mode** – fetch a list of individual URLs and convert each page into a RAGFlow `Document`.
- **Crawl mode** – kick off a Firecrawl crawl job from a seed URL, poll until it finishes, then yield all discovered pages as documents.
- Handles rate-limits (429), retries, and failed pages gracefully.

## Quick start

### 1. Install dependencies

```bash
pip install -r integrations/ragflow/requirements.txt
```

### 2. Get a Firecrawl API key

Sign up at [firecrawl.dev](https://firecrawl.dev) — your key starts with `fc-`.

### 3. Use the connector

```python
from integrations.ragflow.connector import FirecrawlConnector
from integrations.ragflow.config import FirecrawlSourceConfig

config = FirecrawlSourceConfig(
    api_key="fc-YOUR_KEY",
    urls=["https://docs.firecrawl.dev"],
    mode="scrape",          # or "crawl"
    formats=["markdown"],
)

connector = FirecrawlConnector(config)

# RAGFlow calls load_from_state() to pull documents
for batch in connector.load_from_state():
    for doc in batch:
        print(doc.semantic_identifier, len(doc.blob), "bytes")
```

### 4. Crawl an entire site

```python
config = FirecrawlSourceConfig(
    api_key="fc-YOUR_KEY",
    urls=["https://docs.firecrawl.dev"],
    mode="crawl",
    crawl_limit=50,
    formats=["markdown"],
)

connector = FirecrawlConnector(config)

for batch in connector.load_from_state():
    for doc in batch:
        print(doc.semantic_identifier)
```

## Registering in RAGFlow

To add Firecrawl as a data source option in RAGFlow:

1. Copy the `integrations/ragflow/` directory into your RAGFlow installation under `common/data_source/firecrawl/` (or wherever your deployment keeps connectors).

2. Register the connector in RAGFlow's connector configuration. The connector accepts credentials via `load_credentials()`:

```python
connector = FirecrawlConnector(FirecrawlSourceConfig(
    urls=["https://example.com"],
    mode="scrape",
))
connector.load_credentials({
    "firecrawl_api_key": "fc-YOUR_KEY",
    "firecrawl_api_url": "https://api.firecrawl.dev",  # optional
})

for batch in connector.load_from_state():
    # process documents...
    pass
```

3. For the UI side, add a Firecrawl option to RAGFlow's data source selector with fields for:
   - API Key (password field)
   - URLs (text area, one per line)
   - Mode (dropdown: scrape / crawl)
   - Crawl Limit (number, shown when mode=crawl)

## Configuration

| Option | Description | Default |
|---|---|---|
| `api_key` | Firecrawl API key (or set `FIRECRAWL_API_KEY` env var) | — |
| `api_url` | API base URL | `https://api.firecrawl.dev` |
| `urls` | List of URLs to scrape/crawl | `[]` |
| `mode` | `"scrape"` or `"crawl"` | `"scrape"` |
| `crawl_limit` | Max pages for crawl mode | `100` |
| `formats` | Output formats (`markdown`, `html`, etc.) | `["markdown"]` |
| `timeout` | Request timeout in seconds | `60` |
| `max_retries` | Retry count for failed requests | `3` |
| `rate_limit_delay` | Seconds between requests | `1.0` |
| `exclude_tags` | HTML tags to strip (e.g. `["nav", "footer"]`) | `None` |

## Running tests

```bash
cd integrations/ragflow
pip install -r requirements.txt
pytest tests/ -v
```

## How it works

```
RAGFlow                          Firecrawl API
  │                                   │
  │  load_credentials(api_key)        │
  │──────────────────────────────►    │
  │                                   │
  │  load_from_state()                │
  │──┐                                │
  │  │  POST /v2/scrape  ────────►    │
  │  │  ◄──── { markdown, metadata }  │
  │  │                                │
  │  │  ... (for each URL)            │
  │  │                                │
  │◄─┘  yield [Document, ...]        │
  │                                   │
```

For crawl mode, the connector POSTs to `/v2/crawl`, then polls `/v2/crawl/{job_id}` until the job completes before yielding documents.

## License

Same as the parent Firecrawl repository.
