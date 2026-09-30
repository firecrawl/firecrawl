"""The v1 clients must never follow a `next` URL off the configured api_url origin."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from firecrawl.v1.client import AsyncV1FirecrawlApp, V1FirecrawlApp

API_URL = "https://api.firecrawl.dev"


def _page(markdown, next_url=None):
    page = {"success": True, "status": "completed", "completed": 2, "total": 2,
            "creditsUsed": 2, "expiresAt": "2026-10-01T00:00:00Z",
            "data": [{"markdown": markdown}]}
    if next_url:
        page["next"] = next_url
    return page


@pytest.mark.parametrize(
    "next_url, expected",
    [
        ("https://evil.example.com/v1/crawl/id?skip=1", f"{API_URL}/v1/crawl/id?skip=1"),
        ("//evil.example.com/v1/crawl/id?skip=1", f"{API_URL}/v1/crawl/id?skip=1"),
        ("http://api.firecrawl.dev:8443/v1/crawl/id?skip=1", f"{API_URL}/v1/crawl/id?skip=1"),
        (f"{API_URL}/v1/crawl/id?skip=1", f"{API_URL}/v1/crawl/id?skip=1"),
    ],
)
def test_sync_crawl_status_pins_next_url(next_url, expected):
    app = V1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    responses = [
        MagicMock(status_code=200, json=MagicMock(return_value=_page("a", next_url))),
        MagicMock(status_code=200, json=MagicMock(return_value=_page("b"))),
    ]
    with patch("firecrawl.v1.client.requests.get", side_effect=responses) as get:
        status = app.check_crawl_status("id")

    assert [c.args[0] for c in get.call_args_list] == [f"{API_URL}/v1/crawl/id", expected]
    assert [d.markdown for d in status.data] == ["a", "b"]


def test_async_crawl_status_pins_next_url():
    app = AsyncV1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    app._async_get_request = AsyncMock(
        side_effect=[_page("a", "https://evil.example.com/v1/crawl/id?skip=1"), _page("b")]
    )

    status = asyncio.run(app.check_crawl_status("id"))

    urls = [c.args[0] for c in app._async_get_request.await_args_list]
    assert urls == [f"{API_URL}/v1/crawl/id", f"{API_URL}/v1/crawl/id?skip=1"]
    assert [d.markdown for d in status.data] == ["a", "b"]
