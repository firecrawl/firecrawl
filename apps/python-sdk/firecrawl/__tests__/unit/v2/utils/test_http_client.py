from firecrawl.v2.utils.http_client import HttpClient


class TestHttpClientBuildUrl:
    def test_build_url_standard_api_url(self):
        client = HttpClient(api_key="test-key", api_url="https://api.firecrawl.dev")
        assert client._build_url("/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"
        assert client._build_url("v2/scrape") == "https://api.firecrawl.dev/v2/scrape"

    def test_build_url_standard_api_url_trailing_slash(self):
        client = HttpClient(api_key="test-key", api_url="https://api.firecrawl.dev/")
        assert client._build_url("/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"
        assert client._build_url("v2/scrape") == "https://api.firecrawl.dev/v2/scrape"

    def test_build_url_with_path_prefix(self):
        """Preserve reverse proxy path prefix when joining endpoints (fixes #4339)."""
        client = HttpClient(api_key="test-key", api_url="http://firecrawl.example.com/firecrawl")
        assert client._build_url("/v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"
        assert client._build_url("v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"

    def test_build_url_with_path_prefix_trailing_slash(self):
        client = HttpClient(api_key="test-key", api_url="http://firecrawl.example.com/firecrawl/")
        assert client._build_url("/v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"
        assert client._build_url("v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"

    def test_build_url_with_nested_path_and_query(self):
        client = HttpClient(api_key="test-key", api_url="http://localhost:8080/nested/prefix")
        assert client._build_url("/v2/crawl/status?job_id=123") == "http://localhost:8080/nested/prefix/v2/crawl/status?job_id=123"

    def test_build_url_absolute_endpoint_same_host(self):
        client = HttpClient(api_key="test-key", api_url="https://api.firecrawl.dev")
        assert client._build_url("https://api.firecrawl.dev/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"

    def test_build_url_absolute_endpoint_different_host_normalizes_to_base(self):
        client = HttpClient(api_key="test-key", api_url="https://api.firecrawl.dev")
        assert client._build_url("https://attacker.com/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"
