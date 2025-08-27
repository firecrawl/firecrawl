import os
import asyncio
import pytest
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl
from firecrawl.v2.watcher_async import AsyncWatcher


load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


@pytest.mark.asyncio
async def test_async_watcher_crawl_progresses():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=2)
    statuses = []
    async for snapshot in AsyncWatcher(client, start.id, kind="crawl", timeout=180):
        statuses.append(snapshot.status)
        if snapshot.status in ("completed", "failed"):
            break
    assert statuses and statuses[-1] in ("completed", "failed")


@pytest.mark.asyncio
async def test_async_watcher_batch_progresses():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_batch_scrape([
        "https://docs.firecrawl.dev",
        "https://firecrawl.dev",
    ], formats=["markdown"], max_concurrency=1)
    statuses = []
    async for snapshot in AsyncWatcher(client, start.id, kind="batch", timeout=240):
        statuses.append(snapshot.status)
        if snapshot.status in ("completed", "failed", "cancelled"):
            break
    assert statuses and statuses[-1] in ("completed", "failed", "cancelled")

