# RAGFlow + Firecrawl Integration

A Python integration that uses [Firecrawl](https://firecrawl.dev) to scrape web content and ingest it into [RAGFlow](https://github.com/infiniflow/ragflow) for RAG (Retrieval-Augmented Generation) workflows.

## Features

- Scrape single URLs and import content into RAGFlow datasets
- Batch scrape multiple URLs in parallel
- Crawl entire websites with configurable depth and limits
- Automatic retry with exponential backoff for rate limits (429)
- Handles failed requests and malformed content gracefully

## Prerequisites

- Python 3.8+
- A running RAGFlow instance (see [RAGFlow docs](https://ragflow.io/docs/dev/))
- Firecrawl API key from [firecrawl.dev](https://firecrawl.dev)
- RAGFlow API key from your RAGFlow instance settings

## Setup

1. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and fill in your API keys:
   ```
   cp .env.example .env
   ```

3. Make sure your RAGFlow instance is running and accessible at the configured `RAGFLOW_BASE_URL`.

## Usage

### Single URL

```bash
python ragflow_firecrawl.py --url https://docs.firecrawl.dev --dataset "Firecrawl Docs"
```

### Multiple URLs (batch scrape)

```bash
python ragflow_firecrawl.py \
  --urls https://firecrawl.dev https://docs.firecrawl.dev \
  --dataset "Firecrawl Content"
```

### Crawl an entire site

```bash
python ragflow_firecrawl.py \
  --crawl https://docs.firecrawl.dev \
  --limit 20 \
  --dataset "Firecrawl Full Docs"
```

## How It Works

1. **Scrape/Crawl**: Uses the Firecrawl Python SDK to extract clean markdown content from web pages.
2. **Upload**: Sends extracted content as documents to RAGFlow via its REST API.
3. **Parse**: Triggers RAGFlow's document parsing pipeline so documents are chunked and indexed for retrieval.

## License

MIT
