import pytest
from firecrawl.v2.types import JsonFormat, ScrapeOptions
from firecrawl.v2.utils.validation import validate_scrape_options, prepare_scrape_options


class TestValidateScrapeOptions:
    """Unit tests for validate_scrape_options function."""

    def test_validate_none_options(self):
        """Test validation with None options."""
        result = validate_scrape_options(None)
        assert result is None

    def test_validate_valid_options(self):
        """Test validation with valid options."""
        options = ScrapeOptions(
            formats=["markdown"],
            timeout=30000,
            wait_for=2000
        )
        result = validate_scrape_options(options)
        assert result == options

    def test_validate_invalid_timeout(self):
        """Test validation with invalid timeout."""
        options = ScrapeOptions(timeout=0)
        with pytest.raises(ValueError, match="Timeout must be positive"):
            validate_scrape_options(options)

    def test_validate_negative_timeout(self):
        """Test validation with negative timeout."""
        options = ScrapeOptions(timeout=-1000)
        with pytest.raises(ValueError, match="Timeout must be positive"):
            validate_scrape_options(options)

    def test_validate_invalid_wait_for(self):
        """Test validation with invalid wait_for."""
        options = ScrapeOptions(wait_for=-500)
        with pytest.raises(ValueError, match="wait_for must be non-negative"):
            validate_scrape_options(options)

    def test_validate_zero_wait_for(self):
        """Test validation with zero wait_for (should be valid)."""
        options = ScrapeOptions(wait_for=0)
        result = validate_scrape_options(options)
        assert result == options

    def test_validate_complex_options(self):
        """Test validation with complex options."""
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
            remove_base64_images=False,
            raw_html=True,
            screenshot_full_page=True
        )
        result = validate_scrape_options(options)
        assert result == options

    def test_validate_multiple_invalid_fields(self):
        """Test validation with multiple invalid fields."""
        options = ScrapeOptions(timeout=-1000, wait_for=-500)
        with pytest.raises(ValueError, match="Timeout must be positive"):
            validate_scrape_options(options)
        # Should fail on first invalid field (timeout)

    def test_validate_edge_cases(self):
        """Test validation with edge case values."""
        # Test with very large timeout
        options = ScrapeOptions(timeout=999999)
        result = validate_scrape_options(options)
        assert result == options

        # Test with very large wait_for
        options = ScrapeOptions(wait_for=999999)
        result = validate_scrape_options(options)
        assert result == options


class TestPrepareScrapeOptions:
    """Unit tests for prepare_scrape_options function."""

    def test_prepare_none_options(self):
        """Test preparation with None options."""
        result = prepare_scrape_options(None)
        assert result is None

    def test_prepare_basic_options(self):
        """Test preparation with basic options."""
        options = ScrapeOptions(
            formats=["markdown"],
            timeout=30000,
            wait_for=2000
        )
        result = prepare_scrape_options(options)
        
        assert isinstance(result, dict)
        assert "formats" in result
        assert "timeout" in result
        assert "waitFor" in result
        assert result["timeout"] == 30000
        assert result["waitFor"] == 2000

    def test_prepare_snake_case_conversion(self):
        """Test snake_case to camelCase conversion."""
        options = ScrapeOptions(
            include_tags=["h1", "h2"],
            exclude_tags=["nav"],
            only_main_content=False,
            wait_for=2000,
            skip_tls_verification=True,
            remove_base64_images=False
            # Note: raw_html should be in formats array, not as a separate field
        )
        result = prepare_scrape_options(options)
    
        # Check conversions
        assert "includeTags" in result
        assert result["includeTags"] == ["h1", "h2"]
        assert "excludeTags" in result
        assert result["excludeTags"] == ["nav"]
        assert "onlyMainContent" in result
        assert result["onlyMainContent"] is False
        assert "waitFor" in result
        assert result["waitFor"] == 2000
        assert "skipTlsVerification" in result
        assert result["skipTlsVerification"] is True
        assert "removeBase64Images" in result
        assert result["removeBase64Images"] is False
        
        # Check that snake_case fields are not present
        assert "include_tags" not in result
        assert "exclude_tags" not in result
        assert "only_main_content" not in result
        assert "wait_for" not in result
        assert "skip_tls_verification" not in result
        assert "remove_base64_images" not in result

    def test_prepare_complex_options(self):
        """Test preparation with complex options."""
        options = ScrapeOptions(
            formats=["markdown", "html", "rawHtml"],
            headers={"User-Agent": "Test Bot"},
            include_tags=["h1", "h2", "h3"],
            exclude_tags=["nav", "footer"],
            only_main_content=False,
            timeout=15000,
            wait_for=2000,
            mobile=True,
            skip_tls_verification=True,
            remove_base64_images=False
        )
        result = prepare_scrape_options(options)
        
        # Check all fields are present and converted
        assert "formats" in result
        assert "headers" in result
        assert "includeTags" in result
        assert "excludeTags" in result
        assert "onlyMainContent" in result
        assert "timeout" in result
        assert "waitFor" in result
        assert "mobile" in result
        assert "skipTlsVerification" in result
        assert "removeBase64Images" in result
        
        # Check values
        assert result["formats"] == ["markdown", "html", "rawHtml"]
        assert result["headers"] == {"User-Agent": "Test Bot"}
        assert result["includeTags"] == ["h1", "h2", "h3"]
        assert result["excludeTags"] == ["nav", "footer"]
        assert result["onlyMainContent"] is False
        assert result["timeout"] == 15000
        assert result["waitFor"] == 2000
        assert result["mobile"] is True
        assert result["skipTlsVerification"] is True
        assert result["removeBase64Images"] is False

    def test_prepare_invalid_options(self):
        """Test preparation with invalid options (should raise error)."""
        options = ScrapeOptions(timeout=-1000)
        with pytest.raises(ValueError, match="Timeout must be positive"):
            prepare_scrape_options(options)

    def test_prepare_empty_options(self):
        """Test preparation with empty options."""
        options = ScrapeOptions()  # All defaults
        result = prepare_scrape_options(options)
        
        # Should return dict with default values
        assert isinstance(result, dict)
        assert "onlyMainContent" in result
        assert result["onlyMainContent"] is True
        assert "mobile" in result
        assert result["mobile"] is False

    def test_prepare_none_values(self):
        """Test preparation with None values in options."""
        options = ScrapeOptions(
            formats=None,
            timeout=None,
            wait_for=None,
            include_tags=None,
            exclude_tags=None
        )
        result = prepare_scrape_options(options)
        
        # Should only include non-None values
        assert isinstance(result, dict)
        # Should have default values for required fields
        assert "onlyMainContent" in result
        assert "mobile" in result 

    def test_format_schema_conversion(self):
        """Test that Format schema is properly handled."""
        # Create a JsonFormat object with schema
        format_obj = JsonFormat(
            type="json",
            prompt="Extract product info",
            schema={"type": "object", "properties": {"name": {"type": "string"}}}
        )
        
        dumped = format_obj.model_dump()
        assert "schema" in dumped
        assert dumped["schema"] == {"type": "object", "properties": {"name": {"type": "string"}}} 

    def test_prepare_new_v2_fields(self):
        """Test preparation with new v2 fields."""
        from firecrawl.v2.types import Viewport, ScreenshotAction
        
        viewport = Viewport(width=1920, height=1080)
        screenshot_action = ScreenshotAction(
            type="screenshot",
            full_page=True,
            quality=90,
            viewport=viewport
        )
        
        options = ScrapeOptions(
            fast_mode=True,
            use_mock="test-mock",
            block_ads=False,
            store_in_cache=False,
            max_age=7200000,  # 2 hours
            actions=[screenshot_action],
            parsers=["pdf"]
        )
        
        result = prepare_scrape_options(options)
        
        # Check new field conversions
        assert "fastMode" in result
        assert result["fastMode"] is True
        assert "useMock" in result
        assert result["useMock"] == "test-mock"
        assert "blockAds" in result
        assert result["blockAds"] is False
        assert "storeInCache" in result
        assert result["storeInCache"] is False
        assert "maxAge" in result
        assert result["maxAge"] == 7200000
        
        # Check actions conversion
        assert "actions" in result
        assert len(result["actions"]) == 1
        action = result["actions"][0]
        assert action["type"] == "screenshot"
        assert action["fullPage"] is True
        assert action["quality"] == 90
        assert "viewport" in action
        assert action["viewport"]["width"] == 1920
        assert action["viewport"]["height"] == 1080
        
        # Check parsers
        assert "parsers" in result
        assert result["parsers"] == ["pdf"]
        
        # Check that snake_case fields are not present
        assert "fast_mode" not in result
        assert "use_mock" not in result
        assert "block_ads" not in result
        assert "store_in_cache" not in result
        assert "max_age" not in result 