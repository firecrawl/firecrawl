# Firecrawl + RAGFlow Integration

Import web content into [RAGFlow](https://github.com/infiniflow/ragflow) using [Firecrawl](https://firecrawl.dev) for web scraping and content extraction. This integration enables RAGFlow users to build knowledge bases from web sources without manual copying or custom scraping implementations.

## Features

- **Single URL scraping** - Scrape any webpage and import into RAGFlow
- **Batch scraping** - Scrape multiple URLs concurrently and import them all
- **Full website crawling** - Crawl an entire website with depth control and path filtering
- **Automatic document parsing** - Triggers RAGFlow's document processing pipeline after import
- **Rate limit handling** - Exponential backoff retries for rate-limited requests
- **Error handling** - Graceful handling of 401, 403, 404, 429, and timeout errors

## Prerequisites

- Python 3.9+
- A [Firecrawl API key](https://firecrawl.dev) (free tier available)
- A running [RAGFlow](https://github.com/infiniflow/ragflow) instance with an API key

## Setup

1. Install dependencies:

```bash
pip install -r requirements.txt
```

2. Copy the environment template and fill in your credentials:

```bash
cp .env.example .env
```

3. Edit `.env` with your API keys:

```
FIRECRAWL_API_KEY=fc-YOUR_API_KEY
RAGFLOW_API_KEY=ragflow-YOUR_API_KEY
RAGFLOW_BASE_URL=http://localhost:9380
```

## Usage

### Quick Start

```python
from firecrawl_ragflow import FirecrawlRAGFlowConnector

connector = FirecrawlRAGFlowConnector(
    firecrawl_api_key="fc-YOUR_API_KEY",
    ragflow_api_key="ragflow-YOUR_API_KEY",
    ragflow_base_url="http://localhost:9380",
)

# Scrape a single URL and import into RAGFlow
result = connector.scrape_and_import(
    url="https://docs.firecrawl.dev",
    dataset_name="My Knowledge Base",
)
print(f"Imported: {result.document_id}")
```

### Scrape a Single URL

```python
result = connector.scrape_and_import(
    url="https://example.com",
    dataset_name="Example Dataset",
    dataset_description="Content scraped from example.com",
)

if result.success:
    print(f"Document ID: {result.document_id}")
    print(f"Dataset ID: {result.dataset_id}")
else:
    print(f"Error: {result.error}")
```

### Batch Scrape Multiple URLs

```python
urls = [
    "https://docs.firecrawl.dev",
    "https://docs.firecrawl.dev/features/scrape",
    "https://docs.firecrawl.dev/features/crawl",
]

results = connector.batch_scrape_and_import(
    urls=urls,
    dataset_name="Firecrawl Docs",
)

for result in results:
    status = "OK" if result.success else "FAIL"
    print(f"[{status}] {result.url}")
```

### Crawl an Entire Website

```python
results = connector.crawl_and_import(
    url="https://docs.firecrawl.dev",
    dataset_name="Full Documentation",
    max_depth=2,
    limit=50,
    include_paths=["/docs/*"],
    exclude_paths=["/blog/*", "/changelog/*"],
)

successful = sum(1 for r in results if r.success)
print(f"Imported {successful}/{len(results)} pages")
```

### Advanced: Scrape Then Import Separately

For more control, you can separate the scraping and importing steps:

```python
# Step 1: Scrape content
scrape_results = connector.crawl_website(
    url="https://example.com",
    max_depth=1,
    limit=10,
)

# Step 2: Filter or modify results
filtered = [r for r in scrape_results if r.success and len(r.markdown) > 100]

# Step 3: Import to RAGFlow
import_results = connector.import_to_ragflow(
    scrape_results=filtered,
    dataset_name="Filtered Content",
    chunk_method="naive",
    auto_parse=True,
)
```

## Running the Examples

```bash
# Run a specific example
python example.py single   # Scrape one URL
python example.py batch    # Scrape multiple URLs
python example.py crawl    # Crawl a website

# Run all examples
python example.py
```

## Configuration Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `firecrawl_api_key` | required | Firecrawl API key |
| `ragflow_api_key` | required | RAGFlow API key |
| `ragflow_base_url` | required | RAGFlow instance URL |
| `firecrawl_api_url` | `None` | Custom Firecrawl API URL (for self-hosted) |
| `max_retries` | `3` | Maximum retry attempts for failed requests |
| `rate_limit_delay` | `1.0` | Base delay between retries (seconds) |
| `timeout` | `30` | Request timeout (seconds) |

## How It Works

1. **Scraping**: Firecrawl extracts clean markdown content from web pages, handling JavaScript rendering, dynamic content, and complex layouts
2. **Document Creation**: The connector creates markdown files with source metadata headers and uploads them to a RAGFlow dataset
3. **Parsing**: RAGFlow's document processing pipeline automatically chunks and indexes the imported content
4. **Retrieval**: The imported content is available for RAG-based question answering through RAGFlow's chat interface

## Error Handling

The connector handles common failure modes:

| Error | Behavior |
|-------|----------|
| **Rate limiting (429)** | Exponential backoff retry up to `max_retries` |
| **Authentication (401)** | Fails immediately with clear error message |
| **Forbidden (403)** | Fails immediately, no retry |
| **Not found (404)** | Fails immediately, no retry |
| **Timeout** | Retries with exponential backoff |
| **Malformed content** | Logs warning, skips document, continues with remaining |
| **Batch failure** | Falls back to individual URL scraping |

## License

This integration follows the same license as the parent Firecrawl project (AGPL-3.0).
