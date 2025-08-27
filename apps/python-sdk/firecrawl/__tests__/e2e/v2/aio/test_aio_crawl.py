import os
import asyncio
import pytest
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl
from firecrawl.v2.types import ScrapeOptions


load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


@pytest.mark.asyncio
async def test_async_crawl_start_and_status():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=2)
    job_id = start.id

    deadline = asyncio.get_event_loop().time() + 180
    status = await client.get_crawl_status(job_id)
    while status.status not in ("completed", "failed") and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(2)
        status = await client.get_crawl_status(job_id)

    assert status.status in ("completed", "failed")


@pytest.mark.asyncio
async def test_async_crawl_with_all_params():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    # rich scrape options including json format
    json_schema = {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
    }
    status = await client.crawl(
        url="https://docs.firecrawl.dev",
        prompt="Extract docs and blog",
        include_paths=["/docs/*", "/blog/*"],
        exclude_paths=["/admin/*"],
        max_discovery_depth=2,
        ignore_sitemap=False,
        ignore_query_parameters=True,
        limit=5,
        crawl_entire_domain=False,
        allow_external_links=True,
        allow_subdomains=True,
        delay=1,
        max_concurrency=2,
        webhook="https://example.com/hook",
        scrape_options=ScrapeOptions(
            formats=[
                "markdown",
                "rawHtml",
                {"type": "json", "prompt": "Extract title", "schema": json_schema},
            ],
            only_main_content=True,
            mobile=False,
            timeout=20000,
            wait_for=500,
            skip_tls_verification=False,
            remove_base64_images=False,
        ),
        zero_data_retention=False,
        poll_interval=2,
        timeout=180,
    )
    assert status.status in ("completed", "failed")


@pytest.mark.asyncio
async def test_async_start_crawl_with_options():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=5, max_discovery_depth=2)
    assert start.id is not None and start.url is not None


@pytest.mark.asyncio
async def test_async_start_crawl_with_prompt():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://firecrawl.dev", prompt="Extract all blog posts", limit=3)
    assert start.id is not None and start.url is not None


@pytest.mark.asyncio
async def test_async_get_crawl_status_shape():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=3)
    status = await client.get_crawl_status(start.id)
    assert status.status in ("scraping", "completed", "failed")
    assert status.completed >= 0
    assert status.expires_at is not None
    assert isinstance(status.data, list)


@pytest.mark.asyncio
async def test_async_crawl_with_wait():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    job = await client.crawl(url="https://docs.firecrawl.dev", limit=3, max_discovery_depth=2, poll_interval=1, timeout=120)
    assert job.status in ("completed", "failed")
    assert job.completed >= 0 and job.total >= 0 and isinstance(job.data, list)


@pytest.mark.asyncio
async def test_async_crawl_with_prompt_and_wait():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    job = await client.crawl(url="https://docs.firecrawl.dev", prompt="Extract all blog posts", limit=3, poll_interval=1, timeout=120)
    assert job.status in ("completed", "failed")
    assert job.completed >= 0 and job.total >= 0 and isinstance(job.data, list)


@pytest.mark.asyncio
async def test_async_crawl_with_scrape_options():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    scrape_opts = ScrapeOptions(formats=["markdown", "links"], only_main_content=False, mobile=True)
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=2, scrape_options=scrape_opts)
    assert start.id is not None


@pytest.mark.asyncio
async def test_async_crawl_with_json_format_object():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    json_schema = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}
    scrape_opts = ScrapeOptions(formats=[{"type": "json", "prompt": "Extract page title", "schema": json_schema}])
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=2, scrape_options=scrape_opts)
    assert start.id is not None


@pytest.mark.asyncio
async def test_async_cancel_crawl():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=3)
    cancelled = await client.cancel_crawl(start.id)
    assert cancelled is True


@pytest.mark.asyncio
async def test_async_get_crawl_errors_and_invalid_job():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=2)
    errs = await client.get_crawl_errors(start.id)
    assert hasattr(errs, "errors") and hasattr(errs, "robots_blocked")
    with pytest.raises(Exception):
        await client.get_crawl_errors("invalid-job-id-12345")


@pytest.mark.asyncio
async def test_async_active_crawls():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    resp = await client.active_crawls()
    assert hasattr(resp, "success") and hasattr(resp, "crawls")


@pytest.mark.asyncio
async def test_async_active_crawls_with_running_crawl():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    start = await client.start_crawl("https://docs.firecrawl.dev", limit=3)
    # fetch active crawls and assert our ID is listed
    active = await client.active_crawls()
    ids = [c.id for c in active.crawls]
    assert start.id in ids
    # cleanup
    await client.cancel_crawl(start.id)


@pytest.mark.asyncio
async def test_async_crawl_params_preview():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    params = await client.crawl_params_preview(
        url="https://docs.firecrawl.dev",
        prompt="Extract all blog posts and documentation",
    )
    assert params is not None
    # basic sanity: at least one field should be suggested
    has_any = any([
        getattr(params, "limit", None) is not None,
        getattr(params, "include_paths", None) is not None,
        getattr(params, "max_discovery_depth", None) is not None,
    ])
    assert has_any


