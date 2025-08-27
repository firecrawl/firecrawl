#!/usr/bin/env python3
"""
Minimal async examples for Firecrawl v2.

Env variables required:
  - FIRECRAWL_API_KEY
  - FIRECRAWL_API_URL
"""

import os
import asyncio
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl


async def main() -> None:
    load_dotenv()

    api_key = os.getenv("FIRECRAWL_API_KEY")
    if not api_key:
        raise ValueError("FIRECRAWL_API_KEY is not set")

    api_url = os.getenv("FIRECRAWL_API_URL")
    if not api_url:
        raise ValueError("FIRECRAWL_API_URL is not set")

    client = AsyncFirecrawl(api_key=api_key, api_url=api_url)

    # Scrape (minimal)
    doc = await client.v2.scrape("https://docs.firecrawl.dev")
    print("scrape markdown:", doc.markdown)

    # Crawl (waiter)
    crawl_job = await client.v2.crawl(url="https://docs.firecrawl.dev", limit=2, poll_interval=1, timeout=120)
    print("crawl:", crawl_job.status, crawl_job.completed, "/", crawl_job.total)

    # Batch scrape (minimal waiter)
    batch = await client.v2.batch_scrape([
        "https://docs.firecrawl.dev",
        "https://firecrawl.dev",
    ], formats=["markdown"], poll_interval=1, timeout=180)
    print("batch:", batch.status, batch.completed, "/", batch.total)

    # Search (minimal)
    search = await client.v2.search("What is the capital of France?", limit=5)
    web_count = len(getattr(search, "web", []) or []) if hasattr(search, "web") else len(getattr(search, "results", []) or [])
    print("search web results:", web_count)

    # Map (minimal)
    mp = await client.v2.map("https://firecrawl.dev")
    links = getattr(mp, "links", []) or []
    print("map links:", len(links))


if __name__ == "__main__":
    asyncio.run(main())

