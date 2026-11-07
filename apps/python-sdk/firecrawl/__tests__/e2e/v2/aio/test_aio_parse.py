import os
import pytest
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl
from firecrawl.v2.types import Document, ScrapeOptions
from firecrawl.v2.utils.error_handler import FirecrawlError

load_dotenv()
API_KEY = (os.getenv("API_KEY") or "").strip()
API_URL = (os.getenv("API_URL") or "").strip()


@pytest.mark.skipif(
    not API_KEY or not API_URL,
    reason="API_KEY and API_URL are required for async parse e2e tests",
)
@pytest.mark.asyncio
async def test_async_parse_uploaded_html():
    client = AsyncFirecrawl(api_key=API_KEY, api_url=API_URL)
    doc = await client.parse(
        b"<!DOCTYPE html><html><body><h1>Async Python Parse E2E</h1></body></html>",
        filename="python-parse-aio-e2e.html",
        content_type="text/html",
        options=ScrapeOptions(formats=["markdown"]),
    )
    assert isinstance(doc, Document)
    assert doc.markdown is not None
    assert "Async Python Parse E2E" in doc.markdown


@pytest.mark.skipif(
    not API_KEY or not API_URL,
    reason="API_KEY and API_URL are required for async parse e2e tests",
)
@pytest.mark.asyncio
async def test_async_get_parse_formats():
    client = AsyncFirecrawl(api_key=API_KEY, api_url=API_URL)
    try:
        formats = await client.get_parse_formats()
    except FirecrawlError as e:
        if e.status_code == 404:
            pytest.skip("GET /v2/parse/formats is not deployed on this API")
        raise
    assert len(formats) > 0
    assert any(f.format == "pdf" and f.kind == "document" for f in formats)
