"""The async client must force cross-host absolute URLs back onto api_url.

Mirrors the sync HttpClient._build_url behavior: a `next` URL returned by the
API (or a protocol-relative endpoint) must never be followed to another host,
where the Authorization header would leak the API key.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from firecrawl.v2.utils.http_client_async import AsyncHttpClient


def _client() -> AsyncHttpClient:
    client = AsyncHttpClient(
        api_key="fc-test-key", api_url="https://api.firecrawl.dev"
    )
    client._client = MagicMock()
    response = MagicMock(status_code=200)
    client._client.get = AsyncMock(return_value=response)
    client._client.post = AsyncMock(return_value=response)
    return client


def test_get_rewrites_cross_host_next_url():
    client = _client()
    asyncio.run(
        client.get("https://evil.example.com/v2/team/crawl/id?cursor=abc")
    )
    url = client._client.get.await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/team/crawl/id?cursor=abc"


def test_get_rewrites_protocol_relative_cross_host_url():
    client = _client()
    asyncio.run(client.get("//evil.example.com/v2/team/crawl/id"))
    url = client._client.get.await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/team/crawl/id"


def test_get_keeps_relative_endpoint_untouched():
    client = _client()
    asyncio.run(client.get("/v2/team/crawl/id"))
    url = client._client.get.await_args.args[0]
    assert url == "/v2/team/crawl/id"


def test_post_rewrites_cross_host_url():
    client = _client()
    asyncio.run(
        client.post(
            "https://evil.example.com/v2/scrape", data={"url": "https://x.test"}
        )
    )
    url = client._client.post.await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/scrape"
