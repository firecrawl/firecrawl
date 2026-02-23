#!/usr/bin/env python3
"""
RAGFlow + Firecrawl Integration

Scrapes web content using Firecrawl and ingests it into RAGFlow
for Retrieval-Augmented Generation (RAG) workflows.

Usage:
    # Single URL
    python ragflow_firecrawl.py --url https://example.com --dataset "My Dataset"

    # Multiple URLs (batch scrape)
    python ragflow_firecrawl.py --urls https://a.com https://b.com --dataset "My Dataset"

    # Crawl a website
    python ragflow_firecrawl.py --crawl https://example.com --limit 10 --dataset "My Dataset"
"""

import argparse
import hashlib
import os
import sys
import time
from typing import Dict, List, Optional

import requests
from dotenv import load_dotenv
from firecrawl import Firecrawl

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY")
RAGFLOW_API_KEY = os.getenv("RAGFLOW_API_KEY")
RAGFLOW_BASE_URL = os.getenv("RAGFLOW_BASE_URL", "http://localhost:9380")

MAX_RETRIES = 3
RETRY_BACKOFF = 2  # seconds, doubles each retry


# ---------------------------------------------------------------------------
# RAGFlow helpers
# ---------------------------------------------------------------------------


def _ragflow_headers():
    # type: () -> Dict[str, str]
    return {
        "Authorization": "Bearer {}".format(RAGFLOW_API_KEY),
        "Content-Type": "application/json",
    }


def create_dataset(name):
    # type: (str) -> str
    """Create a RAGFlow dataset and return its ID.

    If a dataset with the given name already exists, return its ID.
    """
    # List existing datasets to check for duplicates
    resp = requests.get(
        "{}/api/v1/datasets".format(RAGFLOW_BASE_URL),
        headers=_ragflow_headers(),
        params={"name": name},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    datasets = data.get("data", [])
    for ds in datasets:
        if ds.get("name") == name:
            print("Using existing dataset: {} (id={})".format(name, ds["id"]))
            return ds["id"]

    # Create new dataset
    resp = requests.post(
        "{}/api/v1/datasets".format(RAGFLOW_BASE_URL),
        headers=_ragflow_headers(),
        json={"name": name},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    dataset_id = data["data"]["id"]
    print("Created dataset: {} (id={})".format(name, dataset_id))
    return dataset_id


def upload_document(dataset_id, title, content, source_url):
    # type: (str, str, str, str) -> str
    """Upload a document to a RAGFlow dataset and return the document ID."""
    # RAGFlow expects file uploads via multipart/form-data
    safe_title = title.replace("/", "_").replace(" ", "_")[:100]
    filename = "{}.md".format(safe_title)

    # Build markdown with front-matter for traceability
    body = "---\nsource_url: {}\ntitle: {}\n---\n\n{}".format(source_url, title, content)

    files = {
        "file": (filename, body.encode("utf-8"), "text/markdown"),
    }
    headers = {"Authorization": "Bearer {}".format(RAGFLOW_API_KEY)}

    resp = requests.post(
        "{}/api/v1/datasets/{}/documents".format(RAGFLOW_BASE_URL, dataset_id),
        headers=headers,
        files=files,
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    doc_id = data["data"][0]["id"]
    print("  Uploaded: {} (doc_id={})".format(filename, doc_id))
    return doc_id


def trigger_parsing(dataset_id, document_ids):
    # type: (str, List[str]) -> None
    """Trigger RAGFlow to parse the uploaded documents."""
    resp = requests.post(
        "{}/api/v1/datasets/{}/documents/run".format(RAGFLOW_BASE_URL, dataset_id),
        headers=_ragflow_headers(),
        json={"document_ids": document_ids},
        timeout=60,
    )
    resp.raise_for_status()
    print("  Triggered parsing for {} document(s).".format(len(document_ids)))


# ---------------------------------------------------------------------------
# Firecrawl helpers (with retry logic)
# ---------------------------------------------------------------------------


def _retry(fn, *args, **kwargs):
    """Call *fn* with retries and exponential backoff on rate-limit (429) errors."""
    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            last_exc = exc
            # Detect rate-limit from either HTTP status or message
            err_str = str(exc).lower()
            if "429" in err_str or "rate" in err_str:
                wait = RETRY_BACKOFF * (2 ** attempt)
                print("  Rate limited. Retrying in {}s (attempt {}/{})...".format(
                    wait, attempt + 1, MAX_RETRIES))
                time.sleep(wait)
                continue
            raise
    raise last_exc


def scrape_url(app, url):
    # type: (Firecrawl, str) -> Optional[Dict]
    """Scrape a single URL and return a document dict, or None on failure."""
    try:
        result = _retry(app.scrape, url, formats=["markdown"])
    except Exception as exc:
        print("  Failed to scrape {}: {}".format(url, exc))
        return None

    markdown = ""
    if isinstance(result, dict):
        markdown = result.get("markdown", "")
    elif hasattr(result, "markdown"):
        markdown = result.markdown or ""

    if not markdown or not markdown.strip():
        print("  Warning: empty content from {}".format(url))
        return None

    metadata = {}
    if isinstance(result, dict):
        metadata = result.get("metadata", {})
    elif hasattr(result, "metadata_dict"):
        metadata = result.metadata_dict or {}
    elif hasattr(result, "metadata"):
        md = result.metadata
        metadata = md if isinstance(md, dict) else {}

    title = metadata.get("title") or metadata.get("ogTitle") or url
    doc_id = hashlib.md5(url.encode()).hexdigest()

    return {
        "id": "firecrawl_{}".format(doc_id),
        "title": title,
        "content": markdown,
        "source_url": url,
    }


def scrape_urls(app, urls):
    # type: (Firecrawl, List[str]) -> List[Dict]
    """Scrape a list of URLs using batch scrape and return document dicts."""
    try:
        batch = _retry(
            app.batch_scrape,
            urls,
            formats=["markdown"],
        )
    except Exception as exc:
        print("  Batch scrape failed, falling back to sequential: {}".format(exc))
        docs = []
        for url in urls:
            doc = scrape_url(app, url)
            if doc:
                docs.append(doc)
        return docs

    results = []
    items = []
    if isinstance(batch, dict):
        items = batch.get("data", [])
    elif hasattr(batch, "data"):
        items = batch.data or []

    for item in items:
        markdown = ""
        if isinstance(item, dict):
            markdown = item.get("markdown", "")
        elif hasattr(item, "markdown"):
            markdown = item.markdown or ""

        if not markdown or not markdown.strip():
            continue

        metadata = {}
        if isinstance(item, dict):
            metadata = item.get("metadata", {})
        elif hasattr(item, "metadata_dict"):
            metadata = item.metadata_dict or {}
        elif hasattr(item, "metadata"):
            md = item.metadata
            metadata = md if isinstance(md, dict) else {}

        source = metadata.get("sourceURL") or metadata.get("url") or ""
        title = metadata.get("title") or metadata.get("ogTitle") or source
        doc_id = hashlib.md5(source.encode()).hexdigest()
        results.append({
            "id": "firecrawl_{}".format(doc_id),
            "title": title,
            "content": markdown,
            "source_url": source,
        })

    return results


def crawl_url(app, url, limit=10):
    # type: (Firecrawl, str, int) -> List[Dict]
    """Crawl a website and return document dicts for each page."""
    try:
        crawl_result = _retry(
            app.crawl,
            url,
            limit=limit,
        )
    except Exception as exc:
        print("  Crawl failed for {}: {}".format(url, exc))
        return []

    items = []
    if isinstance(crawl_result, dict):
        items = crawl_result.get("data", [])
    elif hasattr(crawl_result, "data"):
        items = crawl_result.data or []

    results = []
    for item in items:
        markdown = ""
        if isinstance(item, dict):
            markdown = item.get("markdown", "")
        elif hasattr(item, "markdown"):
            markdown = item.markdown or ""

        if not markdown or not markdown.strip():
            continue

        metadata = {}
        if isinstance(item, dict):
            metadata = item.get("metadata", {})
        elif hasattr(item, "metadata_dict"):
            metadata = item.metadata_dict or {}
        elif hasattr(item, "metadata"):
            md = item.metadata
            metadata = md if isinstance(md, dict) else {}

        source = metadata.get("sourceURL") or metadata.get("url") or ""
        title = metadata.get("title") or metadata.get("ogTitle") or source
        doc_id = hashlib.md5(source.encode()).hexdigest()
        results.append({
            "id": "firecrawl_{}".format(doc_id),
            "title": title,
            "content": markdown,
            "source_url": source,
        })

    print("  Crawled {} pages from {}".format(len(results), url))
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def ingest_documents(docs, dataset_name):
    # type: (List[Dict], str) -> None
    """Upload a list of document dicts into a RAGFlow dataset."""
    if not docs:
        print("No documents to ingest.")
        return

    dataset_id = create_dataset(dataset_name)
    doc_ids = []
    for doc in docs:
        try:
            doc_id = upload_document(
                dataset_id,
                title=doc["title"],
                content=doc["content"],
                source_url=doc["source_url"],
            )
            doc_ids.append(doc_id)
        except Exception as exc:
            print("  Failed to upload '{}': {}".format(doc["title"], exc))

    if doc_ids:
        try:
            trigger_parsing(dataset_id, doc_ids)
        except Exception as exc:
            print("  Failed to trigger parsing: {}".format(exc))

    print("\nDone. Ingested {}/{} document(s) into dataset '{}'.".format(
        len(doc_ids), len(docs), dataset_name))


def main():
    parser = argparse.ArgumentParser(
        description="Scrape web content with Firecrawl and ingest into RAGFlow."
    )
    parser.add_argument("--url", help="Single URL to scrape")
    parser.add_argument("--urls", nargs="+", help="Multiple URLs to batch scrape")
    parser.add_argument("--crawl", help="URL to crawl (follows links)")
    parser.add_argument("--limit", type=int, default=10,
                        help="Max pages to crawl (default: 10)")
    parser.add_argument("--dataset", required=True, help="RAGFlow dataset name")
    args = parser.parse_args()

    if not FIRECRAWL_API_KEY:
        print("Error: FIRECRAWL_API_KEY is not set. See .env.example.", file=sys.stderr)
        sys.exit(1)
    if not RAGFLOW_API_KEY:
        print("Error: RAGFLOW_API_KEY is not set. See .env.example.", file=sys.stderr)
        sys.exit(1)

    app = Firecrawl(api_key=FIRECRAWL_API_KEY)
    docs = []

    if args.url:
        print("Scraping: {}".format(args.url))
        doc = scrape_url(app, args.url)
        if doc:
            docs.append(doc)

    if args.urls:
        print("Batch scraping {} URL(s)...".format(len(args.urls)))
        docs.extend(scrape_urls(app, args.urls))

    if args.crawl:
        print("Crawling: {} (limit={})".format(args.crawl, args.limit))
        docs.extend(crawl_url(app, args.crawl, limit=args.limit))

    if not args.url and not args.urls and not args.crawl:
        parser.print_help()
        sys.exit(1)

    ingest_documents(docs, args.dataset)


if __name__ == "__main__":
    main()
