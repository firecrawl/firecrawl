from firecrawl.v2.types import CrawlRequest, ScrapeOptions
from firecrawl.v2.methods.aio.crawl import _prepare_crawl_request
import pytest


class TestAsyncCrawlValidation:
    def test_invalid_url(self):
        with pytest.raises(ValueError):
            _prepare_crawl_request(CrawlRequest(url=""))
        with pytest.raises(ValueError):
            _prepare_crawl_request(CrawlRequest(url="   "))

