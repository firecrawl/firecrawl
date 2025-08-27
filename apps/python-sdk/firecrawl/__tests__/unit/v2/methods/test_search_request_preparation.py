import pytest
from firecrawl.v2.types import SearchRequest, ScrapeOptions, Source
from firecrawl.v2.methods.search import _prepare_search_request


class TestSearchRequestPreparation:
    """Unit tests for search request preparation."""

    def test_basic_request_preparation(self):
        """Test basic request preparation with minimal fields."""
        request = SearchRequest(query="test query")
        data = _prepare_search_request(request)
    
        # Check basic fields
        assert data["query"] == "test query"
        assert data["limit"] == 5
        assert data["timeout"] == 60000
        
        # Check that snake_case fields are not present
        assert "ignore_invalid_urls" not in data
        assert "scrape_options" not in data

    def test_all_fields_conversion(self):
        """Test request preparation with all possible fields."""
        scrape_opts = ScrapeOptions(
            formats=["markdown"],
            headers={"User-Agent": "Test"},
            include_tags=["h1", "h2"],
            exclude_tags=["nav"],
            only_main_content=False,
            timeout=15000,
            wait_for=2000,
            mobile=True,
            skip_tls_verification=True,
            remove_base64_images=False
        )
        
        request = SearchRequest(
            query="test query",
            sources=["web", "news"],
            limit=10,
            tbs="qdr:w",
            location="US",
            ignore_invalid_urls=False,
            timeout=30000,
            scrape_options=scrape_opts
        )
        
        data = _prepare_search_request(request)
        
        # Check all basic fields
        assert data["query"] == "test query"
        assert data["limit"] == 10
        assert data["tbs"] == "qdr:w"
        assert data["location"] == "US"
        assert data["timeout"] == 30000
        
        # Check snake_case to camelCase conversions
        assert "ignoreInvalidURLs" in data
        assert data["ignoreInvalidURLs"] is False
        assert "ignore_invalid_urls" not in data
        
        assert "scrapeOptions" in data
        assert "scrape_options" not in data
        
        # Check sources
        assert "sources" in data
        assert len(data["sources"]) == 2
        assert data["sources"][0]["type"] == "web"
        assert data["sources"][1]["type"] == "news"
        
        # Check nested scrape options conversions
        scrape_data = data["scrapeOptions"]
        assert "includeTags" in scrape_data
        assert scrape_data["includeTags"] == ["h1", "h2"]
        assert "excludeTags" in scrape_data
        assert scrape_data["excludeTags"] == ["nav"]
        assert "onlyMainContent" in scrape_data
        assert scrape_data["onlyMainContent"] is False
        assert "waitFor" in scrape_data
        assert scrape_data["waitFor"] == 2000
        assert "skipTlsVerification" in scrape_data
        assert scrape_data["skipTlsVerification"] is True
        assert "removeBase64Images" in scrape_data
        assert scrape_data["removeBase64Images"] is False

    def test_exclude_none_behavior(self):
        """Test that exclude_none=True behavior is working."""
        request = SearchRequest(
            query="test",
            sources=None,
            limit=None,
            tbs=None,
            location=None,
            ignore_invalid_urls=None,
            timeout=None,
            scrape_options=None
        )
    
        data = _prepare_search_request(request)
    
        # When limit and timeout are explicitly None, they should be excluded
        assert "query" in data
        assert len(data) == 1  # Only query should be present

    def test_empty_scrape_options(self):
        """Test that empty scrape options are handled correctly."""
        scrape_opts = ScrapeOptions()  # All defaults
        
        request = SearchRequest(
            query="test",
            scrape_options=scrape_opts
        )
        
        data = _prepare_search_request(request)
        
        assert "scrapeOptions" in data
        scrape_data = data["scrapeOptions"]
        
        # Should have default values
        assert "onlyMainContent" in scrape_data
        assert scrape_data["onlyMainContent"] is True
        assert "mobile" in scrape_data
        assert scrape_data["mobile"] is False

    def test_scrape_options_shared_function_integration(self):
        """Test that the shared prepare_scrape_options function is being used."""
        # Test with all snake_case fields to ensure conversion
        scrape_opts = ScrapeOptions(
            formats=["markdown", "rawHtml"],
            include_tags=["h1", "h2"],
            exclude_tags=["nav"],
            only_main_content=False,
            wait_for=2000,
            skip_tls_verification=True,
            remove_base64_images=False
            # Note: raw_html should be in formats array, not as a separate field
        )
        
        request = SearchRequest(
            query="test",
            scrape_options=scrape_opts
        )
        
        data = _prepare_search_request(request)
        
        # Check that scrapeOptions is present and converted
        assert "scrapeOptions" in data
        scrape_data = data["scrapeOptions"]
        
        # Check all conversions are working
        assert "formats" in scrape_data
        assert scrape_data["formats"] == ["markdown", "rawHtml"]
        assert "includeTags" in scrape_data
        assert "excludeTags" in scrape_data
        assert "onlyMainContent" in scrape_data
        assert "waitFor" in scrape_data
        assert "skipTlsVerification" in scrape_data
        assert "removeBase64Images" in scrape_data
        
        # Check that snake_case fields are not present
        assert "include_tags" not in scrape_data
        assert "exclude_tags" not in scrape_data
        assert "only_main_content" not in scrape_data
        assert "wait_for" not in scrape_data
        assert "skip_tls_verification" not in scrape_data
        assert "remove_base64_images" not in scrape_data 