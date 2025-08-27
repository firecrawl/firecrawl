import os
import asyncio
import pytest
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl


load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


@pytest.mark.asyncio
async def test_async_batch_start_and_status():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_batch_scrape([
        "https://docs.firecrawl.dev",
        "https://firecrawl.dev",
    ], formats=["markdown"], max_concurrency=1)
    job_id = start.id

    deadline = asyncio.get_event_loop().time() + 240
    status = await client.get_batch_scrape_status(job_id)
    while status.status not in ("completed", "failed", "cancelled") and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(2)
        status = await client.get_batch_scrape_status(job_id)

    assert status.status in ("completed", "failed", "cancelled")


@pytest.mark.asyncio
async def test_async_batch_wait_minimal():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    job = await client.batch_scrape([
        "https://docs.firecrawl.dev",
        "https://firecrawl.dev",
    ], formats=["markdown"], poll_interval=1, timeout=120)
    assert job.status in ("completed", "failed")


@pytest.mark.asyncio
async def test_async_batch_wait_with_all_params():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    json_schema = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}
    job = await client.batch_scrape(
        [
            "https://docs.firecrawl.dev",
            "https://firecrawl.dev",
        ],
        formats=[
            "markdown",
            {"type": "json", "prompt": "Extract page title", "schema": json_schema},
            {"type": "changeTracking", "prompt": "Track changes", "modes": ["json"]},
        ],
        only_main_content=True,
        mobile=False,
        ignore_invalid_urls=True,
        max_concurrency=2,
        zero_data_retention=False,
        poll_interval=1,
        timeout=180,
    )
    assert job.status in ("completed", "failed")


@pytest.mark.asyncio
async def test_async_cancel_batch():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_batch_scrape([
        "https://docs.firecrawl.dev",
        "https://firecrawl.dev",
    ], formats=["markdown"], max_concurrency=1)
    ok = await client.cancel_batch_scrape(start.id)
    assert ok is True

