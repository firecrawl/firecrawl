"""The v1 clients must never follow a `next` URL off the configured api_url origin."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from firecrawl.v1.client import AsyncV1FirecrawlApp, V1FirecrawlApp

API_URL = "https://api.firecrawl.dev"

NEXT_URLS = [
    ("https://evil.example.com/v1/x/id?skip=1", f"{API_URL}/v1/x/id?skip=1"),
    ("//evil.example.com/v1/x/id?skip=1", f"{API_URL}/v1/x/id?skip=1"),
    ("http://api.firecrawl.dev:8443/v1/x/id?skip=1", f"{API_URL}/v1/x/id?skip=1"),
    ("https://evil.example.com/v1/x/id;p=1?skip=1", f"{API_URL}/v1/x/id;p=1?skip=1"),
    (f"{API_URL}/v1/x/id?skip=1", f"{API_URL}/v1/x/id?skip=1"),
]

SYNC_CALLS = [
    ("check_crawl_status", lambda app: app.check_crawl_status("id"), "/v1/crawl/id"),
    ("check_batch_scrape_status", lambda app: app.check_batch_scrape_status("id"), "/v1/batch/scrape/id"),
    ("_monitor_job_status", lambda app: app._monitor_job_status("id", {}, 2), "/v1/crawl/id"),
]

ASYNC_CALLS = [
    ("check_crawl_status", lambda app: app.check_crawl_status("id"), "/v1/crawl/id"),
    ("check_batch_scrape_status", lambda app: app.check_batch_scrape_status("id"), "/v1/batch/scrape/id"),
    ("_async_monitor_job_status", lambda app: app._async_monitor_job_status("id", {}), "/v1/crawl/id"),
]


def _page(markdown, next_url=None):
    page = {"success": True, "status": "completed", "completed": 2, "total": 2,
            "creditsUsed": 2, "expiresAt": "2026-10-01T00:00:00Z",
            "data": [{"markdown": markdown}]}
    if next_url:
        page["next"] = next_url
    return page


@pytest.mark.parametrize("name, call, first_path", SYNC_CALLS, ids=[c[0] for c in SYNC_CALLS])
@pytest.mark.parametrize("next_url, expected", NEXT_URLS)
def test_sync_pagination_pins_next_url(name, call, first_path, next_url, expected):
    app = V1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    responses = [
        MagicMock(status_code=200, json=MagicMock(return_value=_page("a", next_url))),
        MagicMock(status_code=200, json=MagicMock(return_value=_page("b"))),
    ]
    with patch("firecrawl.v1.client.requests.get", side_effect=responses) as get:
        call(app)

    assert [c.args[0] for c in get.call_args_list] == [f"{API_URL}{first_path}", expected]


@pytest.mark.parametrize("name, call, first_path", ASYNC_CALLS, ids=[c[0] for c in ASYNC_CALLS])
@pytest.mark.parametrize("next_url, expected", NEXT_URLS)
def test_async_pagination_pins_next_url(name, call, first_path, next_url, expected):
    app = AsyncV1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    app._async_get_request = AsyncMock(side_effect=[_page("a", next_url), _page("b")])

    asyncio.run(call(app))

    urls = [c.args[0] for c in app._async_get_request.await_args_list]
    assert urls == [f"{API_URL}{first_path}", expected]


def test_sync_crawl_status_keeps_all_pages():
    app = V1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    responses = [
        MagicMock(status_code=200, json=MagicMock(return_value=_page("a", "https://evil.example.com/v1/crawl/id?skip=1"))),
        MagicMock(status_code=200, json=MagicMock(return_value=_page("b"))),
    ]
    with patch("firecrawl.v1.client.requests.get", side_effect=responses):
        status = app.check_crawl_status("id")

    assert [d.markdown for d in status.data] == ["a", "b"]
