import os
import pytest
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl
from firecrawl.v2.types import Document


load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


@pytest.mark.asyncio
async def test_async_scrape_minimal():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    doc = await client.scrape("https://docs.firecrawl.dev")
    assert isinstance(doc, Document)
    assert (
        (doc.markdown and len(doc.markdown) > 0)
        or (doc.html and len(doc.html) > 0)
        or (doc.raw_html and len(doc.raw_html) > 0)
        or (doc.links is not None)
        or (doc.screenshot is not None)
        or (doc.json is not None)
        or (doc.summary is not None)
    )


@pytest.mark.asyncio
async def test_async_scrape_with_all_params():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    # Include multiple formats with configuration
    json_schema = {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
    }
    doc = await client.scrape(
        "https://docs.firecrawl.dev",
        formats=[
            "markdown",
            "rawHtml",
            {"type": "screenshot", "full_page": False, "quality": 70},
            {"type": "json", "prompt": "Extract title", "schema": json_schema},
        ],
        headers={"User-Agent": "E2E-AIO"},
        include_tags=["main"],
        exclude_tags=["nav"],
        only_main_content=True,
        timeout=20000,
        wait_for=500,
        mobile=False,
        parsers=["pdf"],
        actions=[],
        skip_tls_verification=False,
        remove_base64_images=False,
        fast_mode=False,
        use_mock=None,
        block_ads=False,
        proxy="basic",
        max_age=0,
        store_in_cache=False,
    )
    assert isinstance(doc, Document)


@pytest.mark.asyncio
async def test_async_scrape_with_options_markdown():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    doc = await client.scrape(
        "https://docs.firecrawl.dev",
        formats=["markdown"],
        only_main_content=False,
        mobile=False,
    )
    assert isinstance(doc, Document)


@pytest.mark.asyncio
async def test_async_scrape_with_screenshot_action_viewport():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    doc = await client.scrape(
        "https://docs.firecrawl.dev",
        formats=[{"type": "screenshot", "full_page": False, "quality": 80, "viewport": {"width": 800, "height": 600}}],
    )
    assert isinstance(doc, Document)


@pytest.mark.asyncio
@pytest.mark.parametrize("fmt,expect_field", [
    ("markdown", "markdown"),
    ("html", "html"),
    ("raw_html", "raw_html"),
    ("links", "links"),
    ("screenshot", "screenshot"),
    ("summary", "summary"),
])
async def test_async_scrape_basic_formats(fmt, expect_field):
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    doc = await client.scrape("https://docs.firecrawl.dev", formats=[fmt])
    assert isinstance(doc, Document)
    if expect_field == "markdown":
        assert doc.markdown is not None
    elif expect_field == "html":
        assert doc.html is not None
    elif expect_field == "raw_html":
        assert doc.raw_html is not None
    elif expect_field == "links":
        assert isinstance(doc.links, list)
    elif expect_field == "screenshot":
        assert doc.screenshot is not None
    elif expect_field == "summary":
        assert doc.summary is not None


@pytest.mark.asyncio
async def test_async_scrape_with_json_format_object():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    json_schema = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}
    doc = await client.scrape(
        "https://docs.firecrawl.dev",
        formats=[{"type": "json", "prompt": "Extract page title", "schema": json_schema}],
        only_main_content=True,
    )
    assert isinstance(doc, Document)


@pytest.mark.asyncio
async def test_async_scrape_invalid_url():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    with pytest.raises(ValueError):
        await client.scrape("")

