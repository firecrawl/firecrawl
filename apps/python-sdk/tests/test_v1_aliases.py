import pytest
from unittest.mock import patch


ALIAS_MAP = {
    "scrape_url": "scrape",
    "crawl_url": "crawl",
    "map_url": "map",
    "async_crawl_url": "start_crawl",
    "check_crawl_status": "get_crawl_status",
    "check_crawl_errors": "get_crawl_errors",
    "batch_scrape_urls": "batch_scrape",
    "async_batch_scrape_urls": "start_batch_scrape",
    "check_batch_scrape_status": "get_batch_scrape_status",
    "check_batch_scrape_errors": "get_batch_scrape_errors",
}


class TestV2ClientAliases:
    def test_aliases_exist(self):
        from firecrawl.v2.client import FirecrawlClient
        client = FirecrawlClient(api_key="fc-test", api_url="http://localhost:9")
        for alias in ALIAS_MAP:
            assert hasattr(client, alias), f"Missing alias: {alias}"

    def test_aliases_delegate(self):
        from firecrawl.v2.client import FirecrawlClient
        client = FirecrawlClient(api_key="fc-test", api_url="http://localhost:9")
        sentinel = object()
        for alias, target in ALIAS_MAP.items():
            with patch.object(client, target, return_value=sentinel) as mock:
                result = getattr(client, alias)("arg1")
                mock.assert_called_once()
                assert result is sentinel


class TestTopLevelFirecrawlAliases:
    def test_aliases_exposed(self):
        from firecrawl import Firecrawl
        client = Firecrawl(api_key="fc-test", api_url="http://localhost:9")
        for alias in ALIAS_MAP:
            assert hasattr(client, alias), f"Missing on Firecrawl: {alias}"

    def test_aliases_delegate(self):
        from firecrawl import Firecrawl
        client = Firecrawl(api_key="fc-test", api_url="http://localhost:9")
        sentinel = object()
        for alias, target in ALIAS_MAP.items():
            with patch.object(client._v2_client, target, return_value=sentinel) as mock:
                result = getattr(client, alias)("arg1")
                mock.assert_called_once()
                assert result is sentinel


class TestAsyncFirecrawlAliases:
    def test_aliases_exposed(self):
        from firecrawl import AsyncFirecrawl
        client = AsyncFirecrawl(api_key="fc-test", api_url="http://localhost:9")
        for alias in ALIAS_MAP:
            assert hasattr(client, alias), f"Missing on AsyncFirecrawl: {alias}"
