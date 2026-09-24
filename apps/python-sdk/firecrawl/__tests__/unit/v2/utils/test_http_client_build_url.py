from firecrawl.v2.utils.http_client import HttpClient


class TestBuildUrlBasePath:
    def test_preserves_base_path_prefix(self):
        # Self-hosted behind a reverse proxy at a sub-path
        client = HttpClient(api_key="fc-test", api_url="http://localhost:3002/firecrawl")
        assert client._build_url("/v2/search") == "http://localhost:3002/firecrawl/v2/search"

    def test_preserves_base_path_prefix_with_trailing_slash(self):
        client = HttpClient(api_key="fc-test", api_url="http://localhost:3002/firecrawl/")
        assert client._build_url("/v2/search") == "http://localhost:3002/firecrawl/v2/search"

    def test_preserves_nested_base_path_prefix(self):
        client = HttpClient(api_key="fc-test", api_url="https://example.com/api/firecrawl")
        assert client._build_url("/v2/crawl") == "https://example.com/api/firecrawl/v2/crawl"

    def test_root_base_url_is_unchanged(self):
        # Default cloud URL has no path and must keep resolving exactly as before
        client = HttpClient(api_key="fc-test", api_url="https://api.firecrawl.dev")
        assert client._build_url("/v2/search") == "https://api.firecrawl.dev/v2/search"
