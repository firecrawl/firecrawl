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
