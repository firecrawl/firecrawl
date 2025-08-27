import pytest
from firecrawl.v2.types import ScrapeOptions, Viewport, ScreenshotAction
from firecrawl.v2.methods.scrape import _prepare_scrape_request


class TestScrapeRequestPreparation:
    """Unit tests for scrape request preparation."""

    def test_basic_request_preparation(self):
        """Test basic request preparation with minimal fields."""
        data = _prepare_scrape_request("https://example.com")
        
        # Check basic fields
        assert data["url"] == "https://example.com"
        
        # Check that no options are present
        assert "formats" not in data
        assert "headers" not in data

    def test_scrape_options_conversion(self):
        """Test that ScrapeOptions fields are converted to camelCase."""
        options = ScrapeOptions(
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
        
        data = _prepare_scrape_request("https://example.com", options)
        
        # Check basic field
        assert data["url"] == "https://example.com"
        
        # Check snake_case to camelCase conversions
        assert "includeTags" in data
        assert data["includeTags"] == ["h1", "h2"]
        assert "excludeTags" in data
        assert data["excludeTags"] == ["nav"]
        assert "onlyMainContent" in data
        assert data["onlyMainContent"] is False
        assert "waitFor" in data
        assert data["waitFor"] == 2000
        assert "skipTlsVerification" in data
        assert data["skipTlsVerification"] is True
        assert "removeBase64Images" in data
        assert data["removeBase64Images"] is False
        
        # Check that snake_case fields are not present
        assert "include_tags" not in data
        assert "exclude_tags" not in data
        assert "only_main_content" not in data

    def test_actions_conversion(self):
        """Test that actions are converted to camelCase."""
        viewport = Viewport(width=800, height=600)
        action = ScreenshotAction(full_page=False, quality=80, viewport=viewport)
        
        options = ScrapeOptions(actions=[action])
        data = _prepare_scrape_request("https://example.com", options)
        
        assert "actions" in data
        assert len(data["actions"]) == 1
        
        action_data = data["actions"][0]
        assert action_data["type"] == "screenshot"
        assert action_data["fullPage"] is False
        assert action_data["quality"] == 80
        assert "viewport" in action_data

    def test_none_options_handling(self):
        """Test handling of None options."""
        data = _prepare_scrape_request("https://example.com", None)
        
        assert data["url"] == "https://example.com"
        # Should not have any option fields
        assert len(data) == 1

    def test_empty_url_validation(self):
        """Test validation with empty URL."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            _prepare_scrape_request("")

    def test_whitespace_url_validation(self):
        """Test validation with whitespace-only URL."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            _prepare_scrape_request("   ") 