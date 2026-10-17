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


def test_cloud_allows_missing_api_key():
    client = FirecrawlClient(api_url="https://api.firecrawl.dev")
    assert client.http_client.api_key is None


def test_self_host_allows_missing_api_key():
    client = FirecrawlClient(api_url="http://localhost:3000")
    assert client.http_client.api_key is None


@pytest.mark.asyncio
async def test_async_cloud_allows_missing_api_key():
    client = AsyncFirecrawlClient(api_url="https://api.firecrawl.dev")
    try:
        assert client.http_client.api_key is None
        assert client.async_http_client.api_key is None
    finally:
        if not client.async_http_client._client.is_closed:
            await client.async_http_client.close()


@pytest.mark.asyncio
async def test_async_self_host_allows_missing_api_key():
    client = AsyncFirecrawlClient(api_url="http://localhost:3000")
    try:
        assert client.http_client.api_key is None
        assert client.async_http_client.api_key is None
    finally:
        # Ensure the underlying HTTPX client is closed even if assertions fail
        if not client.async_http_client._client.is_closed:
            await client.async_http_client.close()


def test_unified_client_allows_missing_api_key_for_keyless_v2():
    app = Firecrawl(api_url="https://api.firecrawl.dev")
    assert app.api_key is None
    assert app._v2_client is not None
    assert app._v2_client.http_client.api_key is None


@pytest.mark.asyncio
async def test_unified_async_client_allows_missing_api_key_for_keyless_v2():
    app = AsyncFirecrawl(api_url="https://api.firecrawl.dev")
    try:
        assert app.api_key is None
        assert app._v2_client is not None
        assert app._v2_client.http_client.api_key is None
        assert app._v2_client.async_http_client.api_key is None
    finally:
        if not app._v2_client.async_http_client._client.is_closed:
            await app._v2_client.async_http_client.close()


def test_unified_client_v1_access_requires_api_key_on_cloud():
    app = Firecrawl(api_url="https://api.firecrawl.dev")
    with pytest.raises(ValueError, match="No API key provided"):
        _ = app.v1


@pytest.mark.asyncio
async def test_unified_async_client_v1_access_requires_api_key_on_cloud():
    app = AsyncFirecrawl(api_url="https://api.firecrawl.dev")
    try:
        with pytest.raises(ValueError, match="No API key provided"):
            _ = app.v1
    finally:
        if not app._v2_client.async_http_client._client.is_closed:
            await app._v2_client.async_http_client.close()


def test_unified_client_v1_access_succeeds_with_api_key():
    app = Firecrawl(api_key="fc-test-key", api_url="https://api.firecrawl.dev")
    assert app.v1 is not None
    assert hasattr(app.v1, "scrape_url")


def test_unified_client_v1_access_succeeds_on_self_hosted_without_key():
    app = Firecrawl(api_url="http://localhost:3000")
    assert app.v1 is not None
    assert hasattr(app.v1, "scrape_url")

