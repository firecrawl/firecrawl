"""Tests for HttpClient._build_url path-prefix preservation."""

from firecrawl.v2.utils.http_client import HttpClient


class TestBuildUrl:
    """Verify _build_url preserves the base URL's path prefix."""

    def _client(self, api_url: str) -> HttpClient:
        return HttpClient(api_key=None, api_url=api_url)

    def test_no_prefix_root_endpoint(self):
        c = self._client("https://api.firecrawl.dev")
        assert c._build_url("/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"

    def test_no_prefix_trailing_slash(self):
        c = self._client("https://api.firecrawl.dev/")
        assert c._build_url("/v2/scrape") == "https://api.firecrawl.dev/v2/scrape"

    def test_preserves_path_prefix(self):
        c = self._client("https://example.com/firecrawl")
        assert c._build_url("/v2/scrape") == "https://example.com/firecrawl/v2/scrape"

    def test_preserves_path_prefix_trailing_slash(self):
        c = self._client("https://example.com/firecrawl/")
        assert c._build_url("/v2/scrape") == "https://example.com/firecrawl/v2/scrape"

    def test_preserves_deep_path_prefix(self):
        c = self._client("https://example.com/proxy/firecrawl")
        assert c._build_url("/v2/search") == "https://example.com/proxy/firecrawl/v2/search"

    def test_relative_endpoint_no_slash(self):
        c = self._client("https://example.com/firecrawl")
        assert c._build_url("v2/scrape") == "https://example.com/firecrawl/v2/scrape"

    def test_absolute_url_same_host(self):
        c = self._client("https://example.com/firecrawl")
        assert c._build_url("https://example.com/v2/scrape") == "https://example.com/v2/scrape"

    def test_absolute_url_different_host_keeps_base_scheme(self):
        c = self._client("https://example.com/firecrawl")
        result = c._build_url("https://other.example.com/v2/scrape")
        assert result == "https://example.com/v2/scrape"

    def test_protocol_relative(self):
        c = self._client("https://example.com/firecrawl")
        assert c._build_url("//example.com/v2/scrape") == "https://example.com/v2/scrape"

    # --- Query/fragment/params merging tests (cubic coverage) ---

    def test_base_query_merged_with_endpoint_query(self):
        """Base query and endpoint query should be joined with &."""
        c = self._client("https://example.com/firecrawl?token=123")
        assert c._build_url("/v2/search?foo=bar") == "https://example.com/firecrawl/v2/search?token=123&foo=bar"

    def test_base_query_only(self):
        """Base query preserved when endpoint has no query."""
        c = self._client("https://example.com/firecrawl?token=123")
        assert c._build_url("/v2/search") == "https://example.com/firecrawl/v2/search?token=123"

    def test_endpoint_query_only(self):
        """Endpoint query used when base has no query."""
        c = self._client("https://example.com/firecrawl")
        assert c._build_url("/v2/search?foo=bar") == "https://example.com/firecrawl/v2/search?foo=bar"

    def test_base_fragment_merged_with_endpoint_fragment(self):
        """Base fragment preserved when endpoint has no fragment."""
        c = self._client("https://example.com/firecrawl#section")
        assert c._build_url("/v2/search") == "https://example.com/firecrawl/v2/search#section"

    def test_endpoint_fragment_overrides_base(self):
        """Endpoint fragment takes precedence over base fragment."""
        c = self._client("https://example.com/firecrawl#base")
        assert c._build_url("/v2/search#endpoint") == "https://example.com/firecrawl/v2/search#endpoint"

    def test_base_params_merged_with_endpoint_params(self):
        """Base params preserved when endpoint has no params (params are part of path)."""
        c = self._client("https://example.com/firecrawl;v=1")
        # params are part of path component, so they appear after the full path
        assert c._build_url("/v2/search") == "https://example.com/firecrawl/v2/search;v=1"

    def test_endpoint_params_overrides_base(self):
        """Endpoint params take precedence over base params."""
        c = self._client("https://example.com/firecrawl;v=1")
        assert c._build_url("/v2/search;v=2") == "https://example.com/firecrawl/v2/search;v=2"

    def test_endpoint_root_preserves_base_path(self):
        """Endpoint '/' or '' preserves base path with trailing slash."""
        c = self._client("https://example.com/firecrawl")
        assert c._build_url("/") == "https://example.com/firecrawl/"
        assert c._build_url("") == "https://example.com/firecrawl/"

    def test_endpoint_root_with_query(self):
        """Endpoint '/' with query preserves base path and merges queries."""
        c = self._client("https://example.com/firecrawl?token=123")
        assert c._build_url("/?foo=bar") == "https://example.com/firecrawl/?token=123&foo=bar"

    def test_rejects_non_fully_qualified_api_url(self):
        """_build_url should raise ValueError for non-fully-qualified api_url."""
        from firecrawl.v2.utils.http_client import HttpClient
        try:
            HttpClient(api_key=None, api_url="example.com/firecrawl")
            c = HttpClient(api_key=None, api_url="example.com/firecrawl")
            c._build_url("/v2/search")
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "fully qualified" in str(e).lower()
