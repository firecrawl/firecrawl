import os
import pytest
from dotenv import load_dotenv
from firecrawl import AsyncFirecrawl


load_dotenv()

if not os.getenv("API_KEY"):
    raise ValueError("API_KEY is not set")

if not os.getenv("API_URL"):
    raise ValueError("API_URL is not set")


@pytest.mark.asyncio
async def test_async_map_minimal():
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    resp = await client.map("https://docs.firecrawl.dev")
    assert hasattr(resp, "links") and isinstance(resp.links, list)
    if resp.links:
        first = resp.links[0]
        assert hasattr(first, "url") and isinstance(first.url, str) and first.url.startswith("http")


@pytest.mark.asyncio
@pytest.mark.parametrize("sitemap", ["only", "include", "skip"])
async def test_async_map_with_all_params(sitemap):
    client = AsyncFirecrawl(api_key=os.getenv("API_KEY"), api_url=os.getenv("API_URL"))
    resp = await client.map(
        "https://docs.firecrawl.dev",
        search="docs",
        include_subdomains=True,
        limit=10,
        sitemap=sitemap,
        timeout=15000,
    )
    assert hasattr(resp, "links") and isinstance(resp.links, list)
    assert len(resp.links) <= 10

