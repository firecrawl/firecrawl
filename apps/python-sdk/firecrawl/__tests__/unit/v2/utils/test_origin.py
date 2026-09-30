"""Unit tests for configurable request origin attribution."""

from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient
from firecrawl.v2.utils.get_version import get_version


def test_http_client_default_origin():
    client = HttpClient(api_key="fc-test", api_url="https://api.firecrawl.dev")
    assert client.origin == f"python-sdk@{get_version()}"


def test_http_client_custom_origin():
    client = HttpClient(
        api_key="fc-test",
        api_url="https://api.firecrawl.dev",
        origin="arcade-mcp",
    )
    assert client.origin == "arcade-mcp"


def test_async_http_client_custom_origin():
    client = AsyncHttpClient(
        api_key="fc-test",
        api_url="https://api.firecrawl.dev",
        origin="arcade-mcp",
    )
    assert client.origin == "arcade-mcp"


def test_firecrawl_clients_construct_with_origin_and_expose_wait_crawl():
    from firecrawl import Firecrawl, AsyncFirecrawl

    sync_client = Firecrawl(api_key="fc-test", origin="arcade-mcp")
    assert sync_client._v2_client.http_client.origin == "arcade-mcp"
    assert callable(sync_client.wait_crawl)

    async_client = AsyncFirecrawl(api_key="fc-test", origin="arcade-mcp")
    assert callable(async_client.wait_crawl)


def test_sync_wait_crawl_polls_until_terminal(monkeypatch):
    from firecrawl.v2.client import FirecrawlClient
    from firecrawl.v2.methods import crawl as crawl_module
    from firecrawl.v2.types import CrawlJob

    statuses = iter(["scraping", "completed"])

    def fake_status(client, job_id, request_timeout=None):
        return CrawlJob(status=next(statuses), completed=0, total=0, credits_used=0, data=[])

    monkeypatch.setattr(crawl_module, "get_crawl_status", fake_status)
    monkeypatch.setattr(crawl_module.time, "sleep", lambda _: None)

    client = FirecrawlClient(api_key="fc-test")
    assert client.wait_crawl("job-1", poll_interval=0).status == "completed"
