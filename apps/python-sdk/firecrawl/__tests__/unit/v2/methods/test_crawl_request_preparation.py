import pytest
from firecrawl.v2.types import CrawlRequest, ScrapeOptions
from firecrawl.v2.methods.crawl import _prepare_crawl_request


class TestCrawlRequestPreparation:
    """Unit tests for crawl request preparation."""

    def test_basic_request_preparation(self):
        """Test basic request preparation with minimal fields."""
        request = CrawlRequest(url="https://example.com")
        data = _prepare_crawl_request(request)
        
        # Check basic fields
        assert data["url"] == "https://example.com"
        
        # Check that no options are present
        assert "limit" not in data
        assert "prompt" not in data

    def test_crawl_options_conversion(self):
        """Test that CrawlOptions fields are converted to camelCase."""
        request = CrawlRequest(
            url="https://example.com",
            limit=10,
            max_discovery_depth=3,
            sitemap="skip",
            crawl_entire_domain=False,
            allow_external_links=True
        )
        
        data = _prepare_crawl_request(request)
        
        # Check basic field
        assert data["url"] == "https://example.com"
        
        # Check snake_case to camelCase conversions
        assert "limit" in data
        assert data["limit"] == 10
        assert "maxDiscoveryDepth" in data
        assert data["maxDiscoveryDepth"] == 3
        assert "sitemap" in data
        assert data["sitemap"] == "skip"
        assert "crawlEntireDomain" in data
        assert data["crawlEntireDomain"] is False
        assert "allowExternalLinks" in data
        assert data["allowExternalLinks"] is True
        
        # Check that snake_case fields are not present
        assert "ignore_sitemap" not in data
        assert "crawl_entire_domain" not in data
        assert "allow_external_links" not in data

    def test_scrape_options_conversion(self):
        """Test that nested ScrapeOptions are converted to camelCase."""
        scrape_opts = ScrapeOptions(
            formats=["markdown", "html"],
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
        
        request = CrawlRequest(
            url="https://example.com",
            scrape_options=scrape_opts
        )
        
        data = _prepare_crawl_request(request)
        
        assert "scrapeOptions" in data
        assert "scrape_options" not in data
        
        # Check nested conversions
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

    def test_all_fields_conversion(self):
        """Test request preparation with all possible fields."""
        scrape_opts = ScrapeOptions(
            formats=["markdown"],
            headers={"User-Agent": "Test"},
            only_main_content=False,
            mobile=True
        )
        
        request = CrawlRequest(
            url="https://example.com",
            prompt="Extract all blog posts and documentation",
            include_paths=["/blog/*", "/docs/*"],
            exclude_paths=["/admin/*"],
            max_discovery_depth=3,
            sitemap="include",
            limit=100,
            crawl_entire_domain=True,
            allow_external_links=False,
            scrape_options=scrape_opts
        )
        
        data = _prepare_crawl_request(request)
        
        # Check basic fields
        assert data["url"] == "https://example.com"
        assert data["prompt"] == "Extract all blog posts and documentation"
        
        # Check all CrawlOptions fields
        assert "includePaths" in data
        assert data["includePaths"] == ["/blog/*", "/docs/*"]
        assert "excludePaths" in data
        assert data["excludePaths"] == ["/admin/*"]
        assert "maxDiscoveryDepth" in data
        assert data["maxDiscoveryDepth"] == 3
        assert "sitemap" in data
        assert data["sitemap"] == "include"
        assert "limit" in data
        assert data["limit"] == 100
        assert "crawlEntireDomain" in data
        assert data["crawlEntireDomain"] is True
        assert "allowExternalLinks" in data
        assert data["allowExternalLinks"] is False
        
        # Check nested scrape options
        assert "scrapeOptions" in data
        scrape_data = data["scrapeOptions"]
        assert "onlyMainContent" in scrape_data
        assert scrape_data["onlyMainContent"] is False
        assert "mobile" in scrape_data
        assert scrape_data["mobile"] is True

    def test_none_values_handling(self):
        """Test that None values are handled correctly."""
        request = CrawlRequest(
            url="https://example.com",
            prompt=None,
            limit=None,
            scrape_options=None
        )
        
        data = _prepare_crawl_request(request)
        
        # Only the required field should be present
        assert "url" in data
        assert len(data) == 1  # Only url should be present

    def test_prompt_parameter(self):
        """Test that prompt parameter is included when provided."""
        request = CrawlRequest(
            url="https://example.com",
            prompt="Extract all blog posts"
        )
        
        data = _prepare_crawl_request(request)
        
        assert "url" in data
        assert "prompt" in data
        assert data["prompt"] == "Extract all blog posts"

    def test_empty_options(self):
        """Test that empty options are handled correctly."""
        request = CrawlRequest(
            url="https://example.com"
        )
        
        data = _prepare_crawl_request(request)
        
        # Should only have the required url field
        assert "url" in data
        assert len(data) == 1  # Only url should be present

    def test_validation_integration(self):
        """Test that validation is called during preparation."""
        # This should raise an error due to validation
        with pytest.raises(ValueError, match="URL cannot be empty"):
            request = CrawlRequest(url="")
            _prepare_crawl_request(request)
        
        # This should raise an error due to validation
        with pytest.raises(ValueError, match="Limit must be positive"):
            request = CrawlRequest(
                url="https://example.com",
                limit=0
            )
            _prepare_crawl_request(request)

    def test_scrape_options_shared_function_integration(self):
        """Test that the shared prepare_scrape_options function is being used."""
        # Test with all snake_case fields to ensure conversion
        scrape_opts = ScrapeOptions(
            include_tags=["h1", "h2"],
            exclude_tags=["nav"],
            only_main_content=False,
            wait_for=2000,
            skip_tls_verification=True,
            remove_base64_images=False
        )
        
        request = CrawlRequest(
            url="https://example.com",
            scrape_options=scrape_opts
        )
        
        data = _prepare_crawl_request(request)
        
        # Check that scrapeOptions is present and converted
        assert "scrapeOptions" in data
        scrape_data = data["scrapeOptions"]
        
        # Check all conversions are working
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
        assert "raw_html" not in scrape_data
        assert "screenshot_full_page" not in scrape_data 