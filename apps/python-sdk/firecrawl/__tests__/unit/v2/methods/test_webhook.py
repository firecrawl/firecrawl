"""
Unit tests for webhook functionality in Firecrawl v2 SDK.
"""

import pytest
from firecrawl.v2.types import WebhookConfig, CrawlRequest
from firecrawl.v2.methods.crawl import _prepare_crawl_request

class TestWebhookConfig:
    """Test WebhookConfig class functionality."""
    
    def test_webhook_config_creation_minimal(self):
        """Test creating WebhookConfig with minimal parameters."""
        webhook = WebhookConfig(url="https://example.com/webhook")
        assert webhook.url == "https://example.com/webhook"
        assert webhook.headers is None
        assert webhook.metadata is None
        assert webhook.events is None
    
    def test_webhook_config_creation_full(self):
        """Test creating WebhookConfig with all parameters."""
        webhook = WebhookConfig(
            url="https://example.com/webhook",
            headers={"Authorization": "Bearer token"},
            metadata={"project": "test"},
            events=["completed", "failed"]
        )
        assert webhook.url == "https://example.com/webhook"
        assert webhook.headers == {"Authorization": "Bearer token"}
        assert webhook.metadata == {"project": "test"}
        assert webhook.events == ["completed", "failed"]
    
    def test_webhook_config_validation(self):
        """Test WebhookConfig validation."""
        # URL is required
        with pytest.raises(Exception):  # Pydantic validation error
            WebhookConfig()


class TestCrawlRequestWebhook:
    """Test CrawlRequest webhook functionality."""
    
    def test_crawl_request_with_string_webhook(self):
        """Test CrawlRequest with string webhook."""
        request = CrawlRequest(
            url="https://example.com",
            webhook="https://example.com/webhook"
        )
        
        data = _prepare_crawl_request(request)
        assert data["webhook"] == "https://example.com/webhook"
    
    def test_crawl_request_with_webhook_config(self):
        """Test CrawlRequest with WebhookConfig object."""
        webhook_config = WebhookConfig(
            url="https://example.com/webhook",
            headers={"Authorization": "Bearer token"},
            events=["completed"]
        )
        
        request = CrawlRequest(
            url="https://example.com",
            webhook=webhook_config
        )
        
        data = _prepare_crawl_request(request)
        assert data["webhook"]["url"] == "https://example.com/webhook"
        assert data["webhook"]["headers"] == {"Authorization": "Bearer token"}
        assert data["webhook"]["events"] == ["completed"]
    
    def test_crawl_request_without_webhook(self):
        """Test CrawlRequest without webhook."""
        request = CrawlRequest(url="https://example.com")
        
        data = _prepare_crawl_request(request)
        assert "webhook" not in data
    
    def test_crawl_request_webhook_serialization(self):
        """Test that webhook config is properly serialized."""
        webhook_config = WebhookConfig(
            url="https://example.com/webhook",
            headers={"Content-Type": "application/json"},
            metadata={"test": "value"},
            events=["page", "completed"]
        )
        
        request = CrawlRequest(
            url="https://example.com",
            webhook=webhook_config
        )
        
        data = _prepare_crawl_request(request)
        webhook_data = data["webhook"]
        
        # Check that all fields are properly serialized
        assert webhook_data["url"] == "https://example.com/webhook"
        assert webhook_data["headers"] == {"Content-Type": "application/json"}
        assert webhook_data["metadata"] == {"test": "value"}
        assert webhook_data["events"] == ["page", "completed"]
    
    def test_crawl_request_webhook_with_none_values(self):
        """Test webhook config with None values are excluded from serialization."""
        webhook_config = WebhookConfig(
            url="https://example.com/webhook",
            headers=None,
            metadata=None,
            events=None
        )
        
        request = CrawlRequest(
            url="https://example.com",
            webhook=webhook_config
        )
        
        data = _prepare_crawl_request(request)
        webhook_data = data["webhook"]
        
        # Only url should be present, None values should be excluded
        assert webhook_data["url"] == "https://example.com/webhook"
        assert "headers" not in webhook_data
        assert "metadata" not in webhook_data
        assert "events" not in webhook_data 

