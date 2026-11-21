import pytest
from firecrawl.v2.types import MapOptions
from firecrawl.v2.methods.map import _prepare_map_request


class TestMapRequestPreparation:
    """Unit tests for map request preparation."""

    def test_basic_request_preparation(self):
        data = _prepare_map_request("https://example.com")
        assert data["url"] == "https://example.com"
        # Default sitemap handling should be "include" when no flags provided
        assert "sitemap" not in data  # we only send when options provided

    def test_sitemap_transformations(self):
        # sitemap -> "only"
        opts = MapOptions(sitemap="only")
        data = _prepare_map_request("https://example.com", opts)
        assert data["sitemap"] == "only"

        # sitemap -> "skip"
        opts = MapOptions(sitemap="skip")
        data = _prepare_map_request("https://example.com", opts)
        assert data["sitemap"] == "skip"

        # default when options present but sitemap left as default -> include
        opts = MapOptions(search="docs")
        data = _prepare_map_request("https://example.com", opts)
        assert data["sitemap"] == "include"

    def test_field_conversions(self):
        opts = MapOptions(
            search="docs",
            include_subdomains=True,
            limit=25,
            sitemap="only",
            timeout=15000,
            integration="  _unit-test  ",
        )
        data = _prepare_map_request("https://example.com", opts)

        assert data["url"] == "https://example.com"
        assert data["search"] == "docs"
        assert data["includeSubdomains"] is True
        assert data["limit"] == 25
        assert data["sitemap"] == "only"
        assert data["timeout"] == 15000
        assert data["integration"] == "_unit-test"

    def test_invalid_url(self):
        with pytest.raises(ValueError):
            _prepare_map_request("")
        with pytest.raises(ValueError):
            _prepare_map_request("   ")

    def test_ignore_cache_forwarded(self):
        # Regression for issue #4535: ignore_cache is documented in the /v2/map
        # REST API but was missing from MapOptions. Verify the payload carries it.
        opts = MapOptions(ignore_cache=True)
        data = _prepare_map_request("https://example.com", opts)
        assert data["ignoreCache"] is True

        opts = MapOptions(ignore_cache=False)
        data = _prepare_map_request("https://example.com", opts)
        assert data["ignoreCache"] is False

    def test_ignore_cache_omitted_when_unset(self):
        data = _prepare_map_request("https://example.com", MapOptions(limit=10))
        assert "ignoreCache" not in data