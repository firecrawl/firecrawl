from firecrawl.v2.utils.http_client import HttpClient


class TestBuildUrlPathPrefix:
    """A self-hosted Firecrawl behind a reverse proxy path prefix (e.g. nginx serving it
    at "/firecrawl") must keep that prefix on every request, since every v2 method passes
    a leading-slash endpoint (e.g. "/v2/search")."""

    def test_preserves_base_path_prefix(self):
        client = HttpClient(api_key=None, api_url="http://firecrawl.example.com/firecrawl")
        assert client._build_url("/v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"

    def test_preserves_base_path_prefix_with_trailing_slash(self):
        client = HttpClient(api_key=None, api_url="http://firecrawl.example.com/firecrawl/")
        assert client._build_url("/v2/search") == "http://firecrawl.example.com/firecrawl/v2/search"

    def test_root_base_url_unaffected(self):
        client = HttpClient(api_key=None, api_url="https://api.firecrawl.dev")
        assert client._build_url("/v2/search") == "https://api.firecrawl.dev/v2/search"

    def test_endpoint_with_query_string_is_preserved(self):
        client = HttpClient(api_key=None, api_url="http://firecrawl.example.com/firecrawl")
        assert (
            client._build_url("/v2/crawl/123?limit=10")
            == "http://firecrawl.example.com/firecrawl/v2/crawl/123?limit=10"
        )

    def test_absolute_endpoint_on_a_different_host_forces_base_host(self):
        client = HttpClient(api_key=None, api_url="http://firecrawl.example.com/firecrawl")
        result = client._build_url("http://other-host.com/v2/search")
        assert result == "http://firecrawl.example.com/v2/search"
