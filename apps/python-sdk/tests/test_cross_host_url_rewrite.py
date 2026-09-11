"""Regression tests for cross-host URL rewriting (GH issue #4139).

The async client must never send the Authorization header to a host other
than the configured ``api_url`` host. Crawl/batch auto-pagination feeds the
server-provided ``next`` URL straight back into the HTTP client, so an
absolute cross-host URL has to be rewritten onto the configured base, exactly
like the sync ``HttpClient._build_url`` already does.
"""

import asyncio

import httpx
import pytest

from firecrawl.v2.utils.http_client import HttpClient, build_url
from firecrawl.v2.utils.http_client_async import AsyncHttpClient

API_URL = "https://api.firecrawl.dev"


class TestBuildUrl:
    def test_cross_host_absolute_url_is_pinned_to_base(self):
        url = build_url(API_URL, "https://evil.example.com/v2/crawl/job-1?skip=10")
        assert url == "https://api.firecrawl.dev/v2/crawl/job-1?skip=10"

    def test_same_host_absolute_url_keeps_path_and_query(self):
        url = build_url(API_URL, "https://api.firecrawl.dev/v2/crawl/job-1?skip=10")
        assert url == "https://api.firecrawl.dev/v2/crawl/job-1?skip=10"

    def test_same_host_scheme_is_normalized_to_base(self):
        url = build_url(API_URL, "http://api.firecrawl.dev/v2/crawl/job-1")
        assert url == "https://api.firecrawl.dev/v2/crawl/job-1"

    def test_relative_endpoint_is_joined(self):
        assert build_url(API_URL, "/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"
        assert build_url(API_URL, "v2/scrape") == "https://api.firecrawl.dev/v2/scrape"

    def test_protocol_relative_url_is_pinned_to_base(self):
        url = build_url(API_URL, "//evil.example.com/v2/crawl/job-1?skip=5")
        assert url == "https://api.firecrawl.dev/v2/crawl/job-1?skip=5"

    def test_userinfo_and_fragment_are_dropped(self):
        url = build_url(API_URL, "https://user:pass@evil.example.com/v2/x?a=1#frag")
        assert url == "https://api.firecrawl.dev/v2/x?a=1"


class TestSyncAsyncParity:
    """The two clients must resolve URLs identically so they never drift again."""

    CASES = [
        "https://evil.example.com/v2/crawl/job-1?skip=10",
        "https://api.firecrawl.dev/v2/crawl/job-1?skip=10",
        "http://api.firecrawl.dev/v2/crawl/job-1",
        "//evil.example.com/v2/crawl/job-1",
        "/v2/scrape",
        "v2/scrape",
    ]

    def test_async_build_url_matches_sync(self):
        sync_client = HttpClient(api_key="fc-test", api_url=API_URL)
        async_client = AsyncHttpClient(api_key="fc-test", api_url=API_URL)
        try:
            for endpoint in self.CASES:
                assert async_client._build_url(endpoint) == sync_client._build_url(endpoint), endpoint
        finally:
            asyncio.run(async_client.close())


def _install_mock_transport(client: AsyncHttpClient, requests_seen: list) -> None:
    """Swap the client's httpx transport for one that records every request."""

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append(request)
        return httpx.Response(200, json={"success": True})

    old = client._client
    client._client = httpx.AsyncClient(
        base_url=str(old.base_url),
        headers=old.headers,
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.parametrize("verb", ["get", "delete", "post", "patch"])
def test_async_client_never_sends_api_key_cross_host(verb):
    client = AsyncHttpClient(api_key="fc-PROBE-SECRET-KEY", api_url=API_URL)
    seen: list = []
    _install_mock_transport(client, seen)

    async def run():
        method = getattr(client, verb)
        cross_host = "https://evil.example.com/v2/crawl/job-1?skip=10"
        if verb in ("post", "patch"):
            await method(cross_host, data={})
        else:
            await method(cross_host)
        await client.close()

    asyncio.run(run())

    assert len(seen) == 1
    request = seen[0]
    # The request must be pinned to the configured host, path/query preserved.
    assert request.url.host == "api.firecrawl.dev"
    assert request.url.path == "/v2/crawl/job-1"
    assert request.url.params.get("skip") == "10"


def test_async_client_post_multipart_never_sends_api_key_cross_host():
    client = AsyncHttpClient(api_key="fc-PROBE-SECRET-KEY", api_url=API_URL)
    seen: list = []
    _install_mock_transport(client, seen)

    async def run():
        await client.post_multipart(
            "https://evil.example.com/v2/upload",
            data={"k": "v"},
            files={"file": ("f.txt", b"data")},
        )
        await client.close()

    asyncio.run(run())

    assert len(seen) == 1
    assert seen[0].url.host == "api.firecrawl.dev"
    assert seen[0].url.path == "/v2/upload"


def test_async_client_same_host_pagination_still_works():
    """A same-host absolute ``next`` URL must keep working (normal pagination)."""
    client = AsyncHttpClient(api_key="fc-test", api_url=API_URL)
    seen: list = []
    _install_mock_transport(client, seen)

    async def run():
        await client.get("https://api.firecrawl.dev/v2/crawl/job-1?skip=10")
        await client.close()

    asyncio.run(run())

    assert len(seen) == 1
    request = seen[0]
    assert request.url.host == "api.firecrawl.dev"
    assert request.url.path == "/v2/crawl/job-1"
    assert request.url.params.get("skip") == "10"
    assert request.headers.get("Authorization") == "Bearer fc-test"


def test_async_client_relative_endpoint_still_works():
    client = AsyncHttpClient(api_key="fc-test", api_url=API_URL)
    seen: list = []
    _install_mock_transport(client, seen)

    async def run():
        await client.get("/v2/crawl/job-1")
        await client.close()

    asyncio.run(run())

    assert len(seen) == 1
    assert seen[0].url.host == "api.firecrawl.dev"
    assert seen[0].url.path == "/v2/crawl/job-1"
