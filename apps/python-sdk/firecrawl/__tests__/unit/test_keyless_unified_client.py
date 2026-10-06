import pytest

from firecrawl import AsyncFirecrawl, Firecrawl


@pytest.fixture(autouse=True)
def clear_firecrawl_api_key(monkeypatch):
    monkeypatch.delenv("FIRECRAWL_API_KEY", raising=False)


def test_unified_client_allows_keyless_cloud_v2():
    client = Firecrawl()

    assert client._v2_client.http_client.api_key is None
    assert client.v1 is None


@pytest.mark.asyncio
async def test_async_unified_client_allows_keyless_cloud_v2():
    client = AsyncFirecrawl()
    try:
        assert client._v2_client.http_client.api_key is None
        assert client.v1 is None
    finally:
        await client._v2_client.async_http_client.close()


def test_unified_client_keeps_keyless_self_hosted_v1():
    client = Firecrawl(api_url="http://localhost:3002")

    assert client.v1 is not None
    assert client.v1._client.api_key is None
