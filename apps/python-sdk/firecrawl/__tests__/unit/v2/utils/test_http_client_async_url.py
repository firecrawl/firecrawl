"""The async client must force cross-host absolute URLs back onto api_url.

Mirrors the sync HttpClient._build_url behavior: a `next` URL returned by the
API (or a protocol-relative endpoint) must never be followed to another host,
where the Authorization header would leak the API key.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

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


def test_get_rewrites_same_host_alternate_port():
    client = _client()
    asyncio.run(client.get("https://api.firecrawl.dev:8443/v2/team/crawl/id"))
    url = client._client.get.await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/team/crawl/id"


def test_get_rewrites_same_host_http_url():
    client = _client()
    asyncio.run(client.get("http://api.firecrawl.dev/v2/team/crawl/id"))
    url = client._client.get.await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/team/crawl/id"


def test_post_rewrites_cross_host_url():
    client = _client()
    asyncio.run(
        client.post(
            "https://evil.example.com/v2/scrape", data={"url": "https://x.test"}
        )
    )
    url = client._client.post.await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/scrape"


@pytest.mark.parametrize(
    "verb, call",
    [
        ("get", lambda c, url: c.get(url)),
        ("post", lambda c, url: c.post(url, data={})),
        ("post", lambda c, url: c.post_multipart(url, data={}, files={})),
        ("delete", lambda c, url: c.delete(url)),
        ("patch", lambda c, url: c.patch(url, data={})),
    ],
)
def test_every_verb_rewrites_cross_host_url(verb, call):
    client = _client()
    setattr(client._client, verb, AsyncMock(return_value=MagicMock(status_code=200)))
    asyncio.run(call(client, "https://evil.example.com/v2/team/crawl/id?x=1"))
    url = getattr(client._client, verb).await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/team/crawl/id?x=1"


def test_auto_paginated_crawl_status_never_leaves_api_host():
    from firecrawl.v2.methods.aio.crawl import get_crawl_status

    client = _client()
    pages = [
        {"success": True, "status": "completed", "completed": 2, "total": 2,
         "creditsUsed": 2, "data": [{"markdown": "a"}],
         "next": "https://evil.example.com/v2/crawl/id?skip=1"},
        {"success": True, "status": "completed", "completed": 2, "total": 2,
         "creditsUsed": 2, "data": [{"markdown": "b"}]},
    ]
    client._client.get = AsyncMock(
        side_effect=[MagicMock(status_code=200, json=MagicMock(return_value=p)) for p in pages]
    )

    job = asyncio.run(get_crawl_status(client, "id"))

    urls = [c.args[0] for c in client._client.get.await_args_list]
    assert urls == ["/v2/crawl/id", "https://api.firecrawl.dev/v2/crawl/id?skip=1"]
    assert [d.markdown for d in job.data] == ["a", "b"]


def test_rewrite_keeps_path_params():
    client = _client()
    asyncio.run(client.get("https://evil.example.com/v2/crawl/id;p=1?skip=1"))
    url = client._client.get.await_args.args[0]
    assert url == "https://api.firecrawl.dev/v2/crawl/id;p=1?skip=1"


def test_rewrite_refuses_non_absolute_api_url():
    client = AsyncHttpClient(api_key="fc-test-key", api_url="api.firecrawl.dev")
    with pytest.raises(ValueError):
        client._build_url("https://evil.example.com/v2/crawl/id")
