import pytest

from firecrawl.v2.methods import batch, crawl
from firecrawl.v2.types import BatchScrapeJob, CrawlJob
from firecrawl.v2.utils.error_handler import FirecrawlError


class TestWaitTerminalFailure:
    def test_wait_for_batch_completion_raises_on_failed(self):
        batch.get_batch_scrape_status = lambda *args, **kwargs: BatchScrapeJob(
            status="failed", completed=0, total=3, data=[]
        )

        with pytest.raises(FirecrawlError, match="Batch scrape job stub ended with status 'failed'"):
            batch.wait_for_batch_completion(client=None, job_id="stub")

    def test_wait_for_batch_completion_raises_on_cancelled(self):
        batch.get_batch_scrape_status = lambda *args, **kwargs: BatchScrapeJob(
            status="cancelled", completed=0, total=3, data=[]
        )

        with pytest.raises(FirecrawlError, match="Batch scrape job stub ended with status 'cancelled'"):
            batch.wait_for_batch_completion(client=None, job_id="stub")

    def test_wait_for_batch_completion_returns_completed(self):
        expected = BatchScrapeJob(status="completed", completed=3, total=3, data=[])
        batch.get_batch_scrape_status = lambda *args, **kwargs: expected

        result = batch.wait_for_batch_completion(client=None, job_id="stub")
        assert result == expected

    def test_wait_for_crawl_completion_raises_on_failed(self):
        crawl.get_crawl_status = lambda *args, **kwargs: CrawlJob(
            status="failed", completed=0, total=3, data=[]
        )

        with pytest.raises(FirecrawlError, match="Crawl job stub ended with status 'failed'"):
            crawl.wait_for_crawl_completion(client=None, job_id="stub")

    def test_wait_for_crawl_completion_raises_on_cancelled(self):
        crawl.get_crawl_status = lambda *args, **kwargs: CrawlJob(
            status="cancelled", completed=0, total=3, data=[]
        )

        with pytest.raises(FirecrawlError, match="Crawl job stub ended with status 'cancelled'"):
            crawl.wait_for_crawl_completion(client=None, job_id="stub")

    def test_wait_for_crawl_completion_returns_completed(self):
        expected = CrawlJob(status="completed", completed=3, total=3, data=[])
        crawl.get_crawl_status = lambda *args, **kwargs: expected

        result = crawl.wait_for_crawl_completion(client=None, job_id="stub")
        assert result == expected
