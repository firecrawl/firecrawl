import pytest
from firecrawl.v2.types import CrawlRequest, ScrapeOptions
from firecrawl.v2.methods.crawl import _validate_crawl_request


class TestCrawlRequestValidation:
    """Unit tests for crawl request validation."""

    def test_validate_empty_url(self):
        """Test validation with empty URL."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            request = CrawlRequest(url="")
            _validate_crawl_request(request)

    def test_validate_whitespace_url(self):
        """Test validation with whitespace-only URL."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            request = CrawlRequest(url="   ")
            _validate_crawl_request(request)

    def test_validate_valid_url(self):
        """Test validation with valid URL."""
        request = CrawlRequest(url="https://example.com")
        _validate_crawl_request(request)  # Should not raise

    def test_validate_invalid_limit(self):
        """Test validation with invalid limit."""
        with pytest.raises(ValueError, match="Limit must be positive"):
            request = CrawlRequest(
                url="https://example.com",
                limit=0
            )
            _validate_crawl_request(request)

    def test_validate_negative_limit(self):
        """Test validation with negative limit."""
        with pytest.raises(ValueError, match="Limit must be positive"):
            request = CrawlRequest(
                url="https://example.com",
                limit=-5
            )
            _validate_crawl_request(request)

    def test_validate_valid_limit(self):
        """Test validation with valid limit."""
        request = CrawlRequest(
            url="https://example.com",
            limit=10
        )
        _validate_crawl_request(request)  # Should not raise

    def test_validate_with_prompt(self):
        """Test validation with prompt."""
        request = CrawlRequest(
            url="https://example.com",
            prompt="Extract all blog posts"
        )
        _validate_crawl_request(request)  # Should not raise

    def test_validate_with_prompt_and_options(self):
        """Test validation with prompt and options."""
        request = CrawlRequest(
            url="https://example.com",
            prompt="Extract all blog posts",
            limit=10
        )
        _validate_crawl_request(request)  # Should not raise

    def test_validate_none_options(self):
        """Test validation with None options."""
        request = CrawlRequest(url="https://example.com")
        _validate_crawl_request(request)  # Should not raise

    def test_validate_complex_options(self):
        """Test validation with complex options."""
        scrape_opts = ScrapeOptions(
            formats=["markdown"],
            only_main_content=False,
            mobile=True
        )
        
        request = CrawlRequest(
            url="https://example.com",
            limit=50,
            max_discovery_depth=3,
            scrape_options=scrape_opts
        )
        _validate_crawl_request(request)  # Should not raise

    def test_validate_scrape_options_integration(self):
        """Test that scrape_options validation is integrated."""
        # Test with valid scrape options
        scrape_opts = ScrapeOptions(formats=["markdown"], timeout=30000)
        request = CrawlRequest(
            url="https://example.com",
            scrape_options=scrape_opts
        )
        _validate_crawl_request(request)  # Should not raise

        # Test with invalid scrape options (should raise error)
        invalid_scrape_opts = ScrapeOptions(timeout=-1000)
        request = CrawlRequest(
            url="https://example.com",
            scrape_options=invalid_scrape_opts
        )
        with pytest.raises(ValueError, match="Timeout must be positive"):
            _validate_crawl_request(request) 