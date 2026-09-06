import pytest
from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient


class TestHttpClientBuildUrl:
    """Unit tests for _build_url in HttpClient and endpoint resolution in AsyncHttpClient."""

    def test_build_url_standard(self):
        client = HttpClient(api_url="https://api.firecrawl.dev", api_key="fc-test")
        assert client._build_url("/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"
        assert client._build_url("v2/scrape") == "https://api.firecrawl.dev/v2/scrape"

    def test_build_url_with_path_prefix(self):
        # When Firecrawl is deployed behind reverse proxy under a path prefix
        client = HttpClient(api_url="http://firecrawl.example.com/firecrawl", api_key="fc-test")
        assert client._build_url("/v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"
        assert client._build_url("v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"

    def test_build_url_with_path_prefix_trailing_slash(self):
        client = HttpClient(api_url="http://firecrawl.example.com/firecrawl/", api_key="fc-test")
        assert client._build_url("/v2/scrape") == "http://firecrawl.example.com/firecrawl/v2/scrape"
        assert client._build_url("v2/scrape") == "http://firecrawl.example.com/firecrawl/v2/scrape"

    def test_build_url_with_query(self):
        client = HttpClient(api_url="http://firecrawl.example.com/custom/path", api_key="fc-test")
        assert client._build_url("/v2/crawl/status?page=2") == "http://firecrawl.example.com/custom/path/v2/crawl/status?page=2"

    def test_async_http_client_resolve_endpoint(self):
        client = AsyncHttpClient(api_url="http://firecrawl.example.com/firecrawl", api_key="fc-test")
        assert client._resolve_endpoint("/v2/search") == "v2/search"
        assert client._resolve_endpoint("v2/search") == "v2/search"
        assert client._resolve_endpoint("https://external.com/api") == "https://external.com/api"
