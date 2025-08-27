import pytest
from firecrawl.v2.types import SearchRequest, ScrapeOptions
from firecrawl.v2.methods.aio.search import _prepare_search_request


class TestAsyncSearchRequestPreparation:
    def test_basic_request_preparation(self):
        request = SearchRequest(query="test query")
        data = _prepare_search_request(request)
        assert data["query"] == "test query"
        assert "ignore_invalid_urls" not in data
        assert "scrape_options" not in data

    def test_all_fields_conversion(self):
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
            remove_base64_images=False,
        )
        request = SearchRequest(
            query="test query",
            sources=["web", "news"],
            limit=10,
            tbs="qdr:w",
            location="US",
            ignore_invalid_urls=False,
            timeout=30000,
            scrape_options=scrape_opts,
        )
        data = _prepare_search_request(request)
        assert data["ignoreInvalidURLs"] is False
        assert "scrapeOptions" in data

    def test_exclude_none_behavior(self):
        request = SearchRequest(
            query="test",
            sources=None,
            limit=None,
            tbs=None,
            location=None,
            ignore_invalid_urls=None,
            timeout=None,
            scrape_options=None,
        )
        data = _prepare_search_request(request)
        assert "query" in data
        assert len(data) == 1

    def test_empty_scrape_options(self):
        request = SearchRequest(query="test", scrape_options=ScrapeOptions())
        data = _prepare_search_request(request)
        assert "scrapeOptions" in data
        scrape_data = data["scrapeOptions"]
        assert "onlyMainContent" in scrape_data
        assert "mobile" in scrape_data

