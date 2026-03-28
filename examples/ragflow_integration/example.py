"""
Firecrawl + RAGFlow Integration Examples

This script demonstrates how to use the Firecrawl-RAGFlow connector to scrape
web content and import it into RAGFlow for RAG (Retrieval-Augmented Generation)
workflows. It covers three main use cases:

1. Single URL scraping and import
2. Batch URL scraping and import
3. Full website crawling and import

Prerequisites:
    pip install firecrawl-py ragflow-sdk python-dotenv

Environment variables required:
    FIRECRAWL_API_KEY - Your Firecrawl API key (get one at https://firecrawl.dev)
    RAGFLOW_API_KEY   - Your RAGFlow API key
    RAGFLOW_BASE_URL  - Your RAGFlow instance URL (e.g., http://localhost:9380)
"""

import logging
import os
import sys

from dotenv import load_dotenv

from firecrawl_ragflow import FirecrawlRAGFlowConnector

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()


def get_connector() -> FirecrawlRAGFlowConnector:
    """Initialize the connector with credentials from environment variables."""
    firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
    ragflow_api_key = os.getenv("RAGFLOW_API_KEY")
    ragflow_base_url = os.getenv("RAGFLOW_BASE_URL", "http://localhost:9380")

    if not firecrawl_api_key:
        print("Error: FIRECRAWL_API_KEY environment variable is required.")
        print("Get your API key at https://firecrawl.dev")
        sys.exit(1)

    if not ragflow_api_key:
        print("Error: RAGFLOW_API_KEY environment variable is required.")
        print("Set up RAGFlow and get your API key from the settings page.")
        sys.exit(1)

    return FirecrawlRAGFlowConnector(
        firecrawl_api_key=firecrawl_api_key,
        ragflow_api_key=ragflow_api_key,
        ragflow_base_url=ragflow_base_url,
        max_retries=3,
        rate_limit_delay=1.0,
    )


def example_single_url():
    """Example 1: Scrape a single URL and import into RAGFlow."""
    print("\n" + "=" * 60)
    print("Example 1: Single URL Scrape and Import")
    print("=" * 60)

    connector = get_connector()

    result = connector.scrape_and_import(
        url="https://docs.firecrawl.dev",
        dataset_name="Firecrawl Documentation",
        dataset_description="Firecrawl official documentation imported via web scraping",
    )

    if result.success:
        print(f"  Successfully imported: {result.url}")
        print(f"  Document ID: {result.document_id}")
        print(f"  Dataset ID: {result.dataset_id}")
    else:
        print(f"  Failed to import: {result.url}")
        print(f"  Error: {result.error}")


def example_batch_urls():
    """Example 2: Scrape multiple URLs and import into RAGFlow."""
    print("\n" + "=" * 60)
    print("Example 2: Batch URL Scrape and Import")
    print("=" * 60)

    connector = get_connector()

    urls = [
        "https://docs.firecrawl.dev",
        "https://docs.firecrawl.dev/features/scrape",
        "https://docs.firecrawl.dev/features/crawl",
    ]

    results = connector.batch_scrape_and_import(
        urls=urls,
        dataset_name="Firecrawl Docs - Batch Import",
        dataset_description="Selected Firecrawl documentation pages",
    )

    successful = sum(1 for r in results if r.success)
    failed = sum(1 for r in results if not r.success)

    print(f"\n  Results: {successful} succeeded, {failed} failed")
    for result in results:
        status = "OK" if result.success else "FAIL"
        print(f"  [{status}] {result.url}")
        if result.error:
            print(f"         Error: {result.error}")


def example_crawl_website():
    """Example 3: Crawl an entire website and import into RAGFlow."""
    print("\n" + "=" * 60)
    print("Example 3: Full Website Crawl and Import")
    print("=" * 60)

    connector = get_connector()

    results = connector.crawl_and_import(
        url="https://docs.firecrawl.dev",
        dataset_name="Firecrawl Docs - Full Crawl",
        dataset_description="Complete Firecrawl documentation crawled from the web",
        max_depth=2,
        limit=20,
        exclude_paths=["/blog/*", "/changelog/*"],
    )

    successful = sum(1 for r in results if r.success)
    failed = sum(1 for r in results if not r.success)

    print(f"\n  Results: {successful} succeeded, {failed} failed")
    for result in results:
        status = "OK" if result.success else "FAIL"
        print(f"  [{status}] {result.url}")
        if result.document_id:
            print(f"         Document ID: {result.document_id}")
        if result.error:
            print(f"         Error: {result.error}")


if __name__ == "__main__":
    print("Firecrawl + RAGFlow Integration Examples")
    print("=" * 60)
    print("This script demonstrates importing web content into RAGFlow")
    print("using Firecrawl for web scraping.\n")

    if len(sys.argv) > 1:
        example_name = sys.argv[1]
        examples = {
            "single": example_single_url,
            "batch": example_batch_urls,
            "crawl": example_crawl_website,
        }
        if example_name in examples:
            examples[example_name]()
        else:
            print(f"Unknown example: {example_name}")
            print(f"Available examples: {', '.join(examples.keys())}")
            sys.exit(1)
    else:
        print("Usage: python example.py [single|batch|crawl]")
        print()
        print("  single  - Scrape a single URL and import to RAGFlow")
        print("  batch   - Scrape multiple URLs and import to RAGFlow")
        print("  crawl   - Crawl an entire website and import to RAGFlow")
        print()
        print("Running all examples...")
        example_single_url()
        example_batch_urls()
        example_crawl_website()

    print("\nDone!")
