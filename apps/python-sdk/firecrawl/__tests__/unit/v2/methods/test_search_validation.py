import pytest
from firecrawl.v2.types import SearchRequest, Source, ScrapeOptions, ScrapeFormats
from firecrawl.v2.methods.search import _validate_search_request


class TestSearchValidation:
    """Unit tests for search request validation."""

    def test_validate_empty_query(self):
        """Test validation of empty query."""
        request = SearchRequest(query="")
        with pytest.raises(ValueError, match="Query cannot be empty"):
            _validate_search_request(request)

        request = SearchRequest(query="   ")
        with pytest.raises(ValueError, match="Query cannot be empty"):
            _validate_search_request(request)

    def test_validate_invalid_limit(self):
        """Test validation of invalid limits."""
        # Zero limit
        request = SearchRequest(query="test", limit=0)
        with pytest.raises(ValueError, match="Limit must be positive"):
            _validate_search_request(request)

        # Negative limit
        request = SearchRequest(query="test", limit=-1)
        with pytest.raises(ValueError, match="Limit must be positive"):
            _validate_search_request(request)

        # Too high limit
        request = SearchRequest(query="test", limit=101)
        with pytest.raises(ValueError, match="Limit cannot exceed 100"):
            _validate_search_request(request)

    def test_validate_invalid_timeout(self):
        """Test validation of invalid timeouts."""
        # Zero timeout
        request = SearchRequest(query="test", timeout=0)
        with pytest.raises(ValueError, match="Timeout must be positive"):
            _validate_search_request(request)

        # Negative timeout
        request = SearchRequest(query="test", timeout=-1000)
        with pytest.raises(ValueError, match="Timeout must be positive"):
            _validate_search_request(request)

        # Too high timeout
        request = SearchRequest(query="test", timeout=300001)
        with pytest.raises(ValueError, match="Timeout cannot exceed 300000ms"):
            _validate_search_request(request)

    def test_validate_invalid_sources(self):
        """Test validation of invalid sources."""
        # Invalid string source
        request = SearchRequest(query="test", sources=["invalid_source"])
        with pytest.raises(ValueError, match="Invalid source type"):
            _validate_search_request(request)

        # Invalid object source
        request = SearchRequest(query="test", sources=[Source(type="invalid_source")])
        with pytest.raises(ValueError, match="Invalid source type"):
            _validate_search_request(request)

        # Mixed valid/invalid sources
        request = SearchRequest(query="test", sources=["web", "invalid_source"])
        with pytest.raises(ValueError, match="Invalid source type"):
            _validate_search_request(request)

    def test_validate_invalid_location(self):
        """Test validation of invalid location."""
        # Empty location
        request = SearchRequest(query="test", location="")
        with pytest.raises(ValueError, match="Location must be a non-empty string"):
            _validate_search_request(request)

        # Whitespace location
        request = SearchRequest(query="test", location="   ")
        with pytest.raises(ValueError, match="Location must be a non-empty string"):
            _validate_search_request(request)

    def test_validate_invalid_tbs(self):
        """Test validation of invalid tbs values."""
        invalid_tbs_values = ["invalid", "qdr:x", "yesterday", "last_week"]

        for invalid_tbs in invalid_tbs_values:
            request = SearchRequest(query="test", tbs=invalid_tbs)
            with pytest.raises(ValueError, match="Invalid tbs value"):
                _validate_search_request(request)

    def test_validate_custom_date_ranges(self):
        """Test validation of custom date range formats."""
        valid_custom_ranges = [
            "cdr:1,cd_min:1/1/2024,cd_max:12/31/2024",
            "cdr:1,cd_min:12/1/2024,cd_max:12/31/2024",
            "cdr:1,cd_min:2/28/2023,cd_max:3/1/2023",
            "cdr:1,cd_min:10/15/2023,cd_max:11/15/2023"
        ]

        for valid_range in valid_custom_ranges:
            request = SearchRequest(query="test", tbs=valid_range)
            validated = _validate_search_request(request)
            assert validated == request

    def test_validate_invalid_custom_date_ranges(self):
        """Test validation of invalid custom date range formats."""
        # Invalid custom date ranges
        invalid_custom_ranges = [
            "cdr:1,cd_min:2/28/2023",  # Missing cd_max
            "cdr:1,cd_max:2/28/2023",  # Missing cd_min
            "cdr:2,cd_min:1/1/2024,cd_max:12/31/2024",  # Wrong cdr value
            "cdr:cd_min:1/1/2024,cd_max:12/31/2024",  # Missing :1
            "custom:1,cd_min:1/1/2024,cd_max:12/31/2024"  # Wrong prefix
        ]

        for invalid_range in invalid_custom_ranges:
            request = SearchRequest(query="test", tbs=invalid_range)
            with pytest.raises(ValueError, match="Invalid"):
                _validate_search_request(request)

    def test_validate_valid_requests(self):
        """Test that valid requests pass validation."""
        # Minimal valid request
        request = SearchRequest(query="test")
        validated = _validate_search_request(request)
        assert validated == request

        # Request with all optional parameters
        request = SearchRequest(
            query="test query",
            sources=["web", "news"],
            limit=10,
            tbs="qdr:w",
            location="US",
            ignore_invalid_urls=False,
            timeout=30000
        )
        validated = _validate_search_request(request)
        assert validated == request

        # Request with object sources
        request = SearchRequest(
            query="test",
            sources=[Source(type="web"), Source(type="images")]
        )
        validated = _validate_search_request(request)
        assert validated == request

    def test_validate_edge_cases(self):
        """Test edge cases and boundary values."""
        # Maximum valid limit
        request = SearchRequest(query="test", limit=100)
        validated = _validate_search_request(request)
        assert validated == request

        # Maximum valid timeout
        request = SearchRequest(query="test", timeout=300000)
        validated = _validate_search_request(request)
        assert validated == request

        # Minimum valid limit
        request = SearchRequest(query="test", limit=1)
        validated = _validate_search_request(request)
        assert validated == request

        # Minimum valid timeout
        request = SearchRequest(query="test", timeout=1)
        validated = _validate_search_request(request)
        assert validated == request

    def test_validate_none_values(self):
        """Test that None values for optional fields are handled correctly."""
        request = SearchRequest(
            query="test",
            sources=None,
            limit=None,
            tbs=None,
            location=None,
            ignore_invalid_urls=None,
            timeout=None
        )
        validated = _validate_search_request(request)
        assert validated == request

    def test_validate_scrape_options_integration(self):
        """Test that scrape_options validation is integrated."""
        # Test with valid scrape options
        scrape_opts = ScrapeOptions(formats=["markdown"], timeout=30000)
        request = SearchRequest(query="test", scrape_options=scrape_opts)
        validated = _validate_search_request(request)
        assert validated == request

        # Test with invalid scrape options (should raise error)
        invalid_scrape_opts = ScrapeOptions(timeout=-1000)
        request = SearchRequest(query="test", scrape_options=invalid_scrape_opts)
        with pytest.raises(ValueError, match="Timeout must be positive"):
            _validate_search_request(request)





class TestSearchRequestModel:
    """Unit tests for SearchRequest model behavior."""

    def test_default_values(self):
        """Test that default values are set correctly."""
        request = SearchRequest(query="test")
        assert request.limit == 5
        assert request.ignore_invalid_urls is None  # No default in model
        assert request.timeout == 60000
        assert request.sources is None
        assert request.tbs is None
        assert request.location is None
        assert request.scrape_options is None

    def test_field_aliases(self):
        """Test that field aliases work correctly for API serialization."""
        # Test with None value (no default)
        request1 = SearchRequest(query="test")
        data1 = request1.model_dump(by_alias=True)
        assert "ignore_invalid_urls" in data1  # No alias, uses snake_case
        assert data1["ignore_invalid_urls"] is None

        # Test with explicit False value
        request2 = SearchRequest(
            query="test",
            ignore_invalid_urls=False,
            scrape_options=ScrapeOptions(formats=["markdown"])
        )

        # Check that aliases are used in model_dump with by_alias=True
        data2 = request2.model_dump(by_alias=True)
        assert "ignore_invalid_urls" in data2  # No alias, uses snake_case
        assert "scrape_options" in data2  # No alias, uses snake_case
        assert data2["ignore_invalid_urls"] is False
