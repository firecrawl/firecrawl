import pytest

from firecrawl.v2.methods import batch, crawl
from firecrawl.v2.types import BatchScrapeJob, CrawlJob
from firecrawl.v2.utils import FirecrawlError


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_wait_for_batch_completion_can_raise_on_non_success_terminal_status(monkeypatch, status):
    job = BatchScrapeJob(status=status, completed=0, total=2, data=[])
    monkeypatch.setattr(batch, "get_batch_scrape_status", lambda *args, **kwargs: job)

    # Backward-compatible default: return the terminal job.
    assert batch.wait_for_batch_completion(None, "job-id") is job

    with pytest.raises(FirecrawlError, match=f"Batch scrape job job-id ended with status '{status}'"):
        batch.wait_for_batch_completion(None, "job-id", raise_on_failure=True)


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_wait_for_crawl_completion_can_raise_on_non_success_terminal_status(monkeypatch, status):
    job = CrawlJob(id="job-id", status=status, completed=0, total=2, data=[])
    monkeypatch.setattr(crawl, "get_crawl_status", lambda *args, **kwargs: job)

    # Backward-compatible default: return the terminal job.
    assert crawl.wait_for_crawl_completion(None, "job-id") is job

    with pytest.raises(FirecrawlError, match=f"Crawl job job-id ended with status '{status}'"):
        crawl.wait_for_crawl_completion(None, "job-id", raise_on_failure=True)


def test_wait_helpers_return_completed_jobs_when_raise_on_failure_is_enabled(monkeypatch):
    batch_job = BatchScrapeJob(status="completed", completed=2, total=2, data=[])
    crawl_job = CrawlJob(id="job-id", status="completed", completed=2, total=2, data=[])
    monkeypatch.setattr(batch, "get_batch_scrape_status", lambda *args, **kwargs: batch_job)
    monkeypatch.setattr(crawl, "get_crawl_status", lambda *args, **kwargs: crawl_job)

    assert batch.wait_for_batch_completion(None, "job-id", raise_on_failure=True) is batch_job
    assert crawl.wait_for_crawl_completion(None, "job-id", raise_on_failure=True) is crawl_job
