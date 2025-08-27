"""
Unit tests for crawl params functionality in Firecrawl v2 SDK.
"""

import pytest
from firecrawl.v2.types import CrawlParamsRequest, CrawlParamsData


class TestCrawlParamsRequest:
    """Unit tests for CrawlParamsRequest."""

    def test_crawl_params_request_creation(self):
        """Test creating CrawlParamsRequest with valid data."""
        request = CrawlParamsRequest(
            url="https://example.com",
            prompt="Extract all blog posts"
        )
        
        assert request.url == "https://example.com"
        assert request.prompt == "Extract all blog posts"

    def test_crawl_params_request_serialization(self):
        """Test that CrawlParamsRequest serializes correctly."""
        request = CrawlParamsRequest(
            url="https://example.com",
            prompt="Extract all blog posts and documentation"
        )
        
        data = request.model_dump()
        
        assert data["url"] == "https://example.com"
        assert data["prompt"] == "Extract all blog posts and documentation"


class TestCrawlParamsData:
    """Unit tests for CrawlParamsData."""

    def test_crawl_params_data_creation(self):
        """Test creating CrawlParamsData with minimal data."""
        data = CrawlParamsData()
        
        assert data.include_paths is None
        assert data.exclude_paths is None
        assert data.max_discovery_depth is None
        assert data.ignore_sitemap is False
        assert data.limit is None
        assert data.crawl_entire_domain is False
        assert data.allow_external_links is False
        assert data.scrape_options is None
        assert data.warning is None

    def test_crawl_params_data_with_values(self):
        """Test creating CrawlParamsData with values."""
        data = CrawlParamsData(
            include_paths=["/blog/*"],
            exclude_paths=["/admin/*"],
            max_discovery_depth=3,
            limit=50,
            crawl_entire_domain=True,
            allow_external_links=False,
            warning="Test warning"
        )
        
        assert data.include_paths == ["/blog/*"]
        assert data.exclude_paths == ["/admin/*"]
        assert data.max_discovery_depth == 3
        assert data.limit == 50
        assert data.crawl_entire_domain is True
        assert data.allow_external_links is False
        assert data.warning == "Test warning" 