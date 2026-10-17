import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient


@pytest.fixture(autouse=True)
def clear_firecrawl_api_key_env(monkeypatch):
    monkeypatch.delenv("FIRECRAWL_API_KEY", raising=False)
    yield


def test_unified_client_allows_keyless_cloud():
    """Firecrawl() without an API key should succeed, enabling keyless scrape/search."""
    client = Firecrawl()
    assert client.api_key is None
    assert client._v2_client.http_client.api_key is None
    assert callable(client.scrape)
    assert callable(client.search)

    # Truthiness reflects whether underlying v1 client is initialized
    assert not bool(client.v1)
    assert hasattr(client.v1, "scrape_url")
    assert not hasattr(client.v1, "non_existent_method")

    # v1 methods require an API key for cloud
    with pytest.raises(ValueError, match="No API key provided"):
        client.v1.scrape_url("https://example.com")


@pytest.mark.asyncio
async def test_async_unified_client_allows_keyless_cloud():
    """AsyncFirecrawl() without an API key should succeed."""
    client = AsyncFirecrawl()
    assert client.api_key is None
    assert client._v2_client.http_client.api_key is None
    assert callable(client.scrape)
    assert callable(client.search)

    assert not bool(client.v1)
    assert hasattr(client.v1, "scrape_url")
    assert not hasattr(client.v1, "non_existent_method")

    with pytest.raises(ValueError, match="No API key provided"):
        await client.v1.scrape_url("https://example.com")


def test_unified_client_with_api_key():
    client = Firecrawl(api_key="fc-test-key")
    assert client.api_key == "fc-test-key"
    assert bool(client.v1)
    assert client.v1._client is client._v1_client
    assert client.v1.scrape_url == client._v1_client.scrape_url


def test_v2_client_allows_keyless_cloud():
    client = FirecrawlClient(api_url="https://api.firecrawl.dev")
    assert client.http_client.api_key is None


def test_self_host_allows_missing_api_key():
    client = FirecrawlClient(api_url="http://localhost:3000")
    assert client.http_client.api_key is None


@pytest.mark.asyncio
async def test_async_v2_client_allows_keyless_cloud():
    client = AsyncFirecrawlClient(api_url="https://api.firecrawl.dev")
    try:
        assert client.http_client.api_key is None
        await client.async_http_client.close()
    finally:
        if not client.async_http_client._client.is_closed:
            await client.async_http_client.close()


@pytest.mark.asyncio
async def test_async_self_host_allows_missing_api_key():
    client = AsyncFirecrawlClient(api_url="http://localhost:3000")
    try:
        assert client.http_client.api_key is None
        await client.async_http_client.close()
    finally:
        if not client.async_http_client._client.is_closed:
            await client.async_http_client.close()
