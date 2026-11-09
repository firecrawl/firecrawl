from unittest.mock import AsyncMock, Mock

import pytest
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import SearchRequest, ScrapeOptions
from firecrawl.v2.methods.aio.search import _prepare_search_request
from firecrawl.v2.methods.aio.search import search as search_async


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
            exclude_domains=["example.com"],
            limit=10,
            tbs="qdr:w",
            location="US",
            country="de",
            ignore_invalid_urls=False,
            timeout=30000,
            scrape_options=scrape_opts,
            integration="  _unit-test  ",
        )
        data = _prepare_search_request(request)
        assert data["ignoreInvalidURLs"] is False
        assert data["country"] == "de"
        assert data["excludeDomains"] == ["example.com"]
        assert "exclude_domains" not in data
        assert "scrapeOptions" in data
        assert data["integration"] == "_unit-test"

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

    def test_country_is_included_when_set(self):
        """Test that country reaches the prepared body."""
        request = SearchRequest(query="test", country="de")
        data = _prepare_search_request(request)
        assert data["country"] == "de"

    def test_country_is_omitted_when_unset(self):
        """Test that the body omits country when it is not set."""
        request = SearchRequest(query="test")
        data = _prepare_search_request(request)
        assert "country" not in data

    def test_domain_filters_are_mutually_exclusive(self):
        with pytest.raises(
            ValueError,
            match="include_domains and exclude_domains cannot both be specified",
        ):
            SearchRequest(
                query="test",
                include_domains=["firecrawl.dev"],
                exclude_domains=["example.com"],
            )

    def test_empty_scrape_options(self):
        request = SearchRequest(query="test", scrape_options=ScrapeOptions())
        data = _prepare_search_request(request)
        assert "scrapeOptions" in data
        scrape_data = data["scrapeOptions"]
        assert "onlyMainContent" in scrape_data
        assert "mobile" in scrape_data


def _ok_response():
    """Minimal successful search response."""
    response = Mock()
    response.status_code = 200
    response.json.return_value = {"success": True, "data": {}}
    return response


def _mock_client():
    client = Mock()
    client.post = AsyncMock(return_value=_ok_response())
    return client


class TestAsyncSearchPostsCountry:
    """The async client accepted country and dropped it. Pin the body."""

    @pytest.mark.asyncio
    async def test_country_reaches_the_posted_body(self):
        """Test that the async search posts country."""
        client = _mock_client()

        await search_async(client, SearchRequest(query="test", country="de"))

        path, body = client.post.call_args[0]
        assert path == "/v2/search"
        assert body["country"] == "de"

    @pytest.mark.asyncio
    async def test_posted_body_omits_country_when_unset(self):
        """Test that the async search omits country when it is not set."""
        client = _mock_client()

        await search_async(client, SearchRequest(query="test"))

        _path, body = client.post.call_args[0]
        assert "country" not in body

    @pytest.mark.asyncio
    async def test_async_client_forwards_country_kwarg(self):
        """AsyncFirecrawlClient.search takes **kwargs. Pin the passthrough."""
        client = AsyncFirecrawlClient(api_key="fc-test")
        client.async_http_client.post = AsyncMock(return_value=_ok_response())

        await client.search("test", country="de")

        _path, body = client.async_http_client.post.call_args[0]
        assert body["country"] == "de"
