"""v1 batch_scrape_urls must poll the batch scrape status endpoint; crawl_url keeps polling crawl status."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from firecrawl.v1.client import (
    AsyncV1FirecrawlApp,
    V1BatchScrapeStatusResponse,
    V1CrawlStatusResponse,
    V1FirecrawlApp,
)

API_URL = "https://api.firecrawl.dev"


def _page(status, markdown=None, next_url=None):
    page = {"success": True, "status": status, "completed": 2, "total": 2,
            "creditsUsed": 2, "expiresAt": "2026-10-01T00:00:00Z",
            "data": [{"markdown": markdown}] if markdown else []}
    if next_url:
        page["next"] = next_url
    return page


def _pages(path):
    return [
        _page("scraping"),
        _page("completed", "a", f"https://evil.example.com{path}?skip=1"),
        _page("completed", "b"),
    ]


def _expected_urls(path):
    return [f"{API_URL}{path}", f"{API_URL}{path}", f"{API_URL}{path}?skip=1"]


SYNC_JOBS = [
    ("batch_scrape_urls", lambda app: app.batch_scrape_urls(["https://example.com"]), "/v1/batch/scrape/job-id", V1BatchScrapeStatusResponse),
    ("crawl_url", lambda app: app.crawl_url("https://example.com"), "/v1/crawl/job-id", V1CrawlStatusResponse),
]


@pytest.mark.parametrize("name, call, path, response_type", SYNC_JOBS, ids=[j[0] for j in SYNC_JOBS])
def test_sync_waiter_polls_matching_status_endpoint(name, call, path, response_type):
    app = V1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    start = MagicMock(status_code=200, json=MagicMock(return_value={"success": True, "id": "job-id"}))
    polls = [MagicMock(status_code=200, json=MagicMock(return_value=p)) for p in _pages(path)]

    with patch("firecrawl.v1.client.requests.post", return_value=start), \
         patch("firecrawl.v1.client.requests.get", side_effect=polls) as get, \
         patch("firecrawl.v1.client.time.sleep"):
        result = call(app)

    assert [c.args[0] for c in get.call_args_list] == _expected_urls(path)
    assert type(result) is response_type
    assert [d.markdown for d in result.data] == ["a", "b"]


def test_sync_batch_scrape_failure_mentions_batch_scrape():
    app = V1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    start = MagicMock(status_code=200, json=MagicMock(return_value={"success": True, "id": "job-id"}))
    failed = MagicMock(status_code=200, json=MagicMock(return_value=_page("failed")))

    with patch("firecrawl.v1.client.requests.post", return_value=start), \
         patch("firecrawl.v1.client.requests.get", return_value=failed):
        with pytest.raises(Exception, match="Batch scrape job failed"):
            app.batch_scrape_urls(["https://example.com"])


ASYNC_JOBS = [
    ("batch_scrape_urls", lambda app: app.batch_scrape_urls(["https://example.com"]), "/v1/batch/scrape/job-id", V1BatchScrapeStatusResponse),
    ("crawl_url", lambda app: app.crawl_url("https://example.com"), "/v1/crawl/job-id", V1CrawlStatusResponse),
]


@pytest.mark.parametrize("name, call, path, response_type", ASYNC_JOBS, ids=[j[0] for j in ASYNC_JOBS])
def test_async_waiter_polls_matching_status_endpoint(name, call, path, response_type):
    app = AsyncV1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    app._async_post_request = AsyncMock(return_value={"success": True, "id": "job-id"})
    app._async_get_request = AsyncMock(side_effect=_pages(path))

    with patch("firecrawl.v1.client.asyncio.sleep", new=AsyncMock()):
        result = asyncio.run(call(app))

    assert [c.args[0] for c in app._async_get_request.await_args_list] == _expected_urls(path)
    assert type(result) is response_type
    assert [d.markdown for d in result.data] == ["a", "b"]


def test_async_batch_scrape_failure_mentions_batch_scrape():
    app = AsyncV1FirecrawlApp(api_key="fc-test-key", api_url=API_URL)
    app._async_post_request = AsyncMock(return_value={"success": True, "id": "job-id"})
    app._async_get_request = AsyncMock(return_value=_page("failed"))

    with pytest.raises(Exception, match="Batch scrape job failed"):
        asyncio.run(app.batch_scrape_urls(["https://example.com"]))
