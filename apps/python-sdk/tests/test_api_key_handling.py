import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

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
    finally:
        await client.async_http_client.close()


@pytest.mark.asyncio
async def test_async_self_host_allows_missing_api_key():
    client = AsyncFirecrawlClient(api_url="http://localhost:3000")
    try:
        assert client.http_client.api_key is None
        await client.async_http_client.close()
    finally:
        # Ensure the underlying HTTPX client is closed even if assertions fail
        if not client.async_http_client._client.is_closed:
            await client.async_http_client.close()
