import pytest
from firecrawl.v2.types import MapOptions
from firecrawl.v2.methods.aio.map import _prepare_map_request


class TestAsyncMapRequestPreparation:
    def test_basic(self):
        payload = _prepare_map_request("https://example.com")
        assert payload["url"] == "https://example.com"

    def test_fields(self):
        opts = MapOptions(search="docs", include_subdomains=True, limit=10, sitemap="only", timeout=15000)
        payload = _prepare_map_request("https://example.com", opts)
        assert payload["search"] == "docs"
        assert payload["includeSubdomains"] is True
        assert payload["limit"] == 10
        assert payload["sitemap"] == "only"
        assert payload["timeout"] == 15000

