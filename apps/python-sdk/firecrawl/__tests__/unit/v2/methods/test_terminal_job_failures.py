import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.methods import batch, crawl
from firecrawl.v2.types import BatchScrapeJob, CrawlJob, Document
from firecrawl.v2.utils import CrawlJobFailedError, FirecrawlError


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_wait_for_batch_completion_can_raise_on_non_success_terminal_status(monkeypatch, status):
    job = BatchScrapeJob(status=status, completed=0, total=2, data=[])
    monkeypatch.setattr(batch, "get_batch_scrape_status", lambda *args, **kwargs: job)

    # Backward-compatible default: return the terminal job.
    assert batch.wait_for_batch_completion(None, "job-id") is job

    with pytest.raises(
        FirecrawlError,
        match=f"Batch scrape job job-id ended with status '{status}'",
    ):
        batch.wait_for_batch_completion(None, "job-id", raise_on_failure=True)


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_wait_for_crawl_completion_preserves_job_when_raising(monkeypatch, status):
    partial_document = Document(markdown="partial result")
    job = CrawlJob(
        id="job-id",
        status=status,
        completed=1,
        total=2,
        data=[partial_document],
    )
    monkeypatch.setattr(crawl, "get_crawl_status", lambda *args, **kwargs: job)

    # Backward-compatible default: return the terminal job.
    assert crawl.wait_for_crawl_completion(None, "job-id") is job

    with pytest.raises(CrawlJobFailedError) as exc_info:
        crawl.wait_for_crawl_completion(None, "job-id", raise_on_failure=True)

    error = exc_info.value
    assert error.job is job
    assert error.job_id == "job-id"
    assert error.status == status
    assert error.job.data == [partial_document]


def test_wait_helpers_return_completed_jobs_when_raise_on_failure_is_enabled(monkeypatch):
    batch_job = BatchScrapeJob(status="completed", completed=2, total=2, data=[])
    crawl_job = CrawlJob(id="job-id", status="completed", completed=2, total=2, data=[])
    monkeypatch.setattr(batch, "get_batch_scrape_status", lambda *args, **kwargs: batch_job)
    monkeypatch.setattr(crawl, "get_crawl_status", lambda *args, **kwargs: crawl_job)

    assert batch.wait_for_batch_completion(None, "job-id", raise_on_failure=True) is batch_job
    assert crawl.wait_for_crawl_completion(None, "job-id", raise_on_failure=True) is crawl_job


@pytest.mark.parametrize("raise_on_failure", [False, True])
def test_public_crawl_forwards_raise_on_failure(monkeypatch, raise_on_failure):
    client = FirecrawlClient(api_key="test")
    received = {}

    def fake_crawl(http_client, request, **kwargs):
        received.update(kwargs)
        return CrawlJob(id="job-id", status="completed", completed=1, total=1, data=[])

    monkeypatch.setattr("firecrawl.v2.client.crawl_module.crawl", fake_crawl)

    client.crawl("https://example.com", raise_on_failure=raise_on_failure)

    assert received["raise_on_failure"] is raise_on_failure


@pytest.mark.parametrize("raise_on_failure", [False, True])
def test_public_wait_crawl_forwards_raise_on_failure(monkeypatch, raise_on_failure):
    client = FirecrawlClient(api_key="test")
    received = {}

    def fake_wait(http_client, job_id, **kwargs):
        received.update(kwargs)
        return CrawlJob(id=job_id, status="completed", completed=1, total=1, data=[])

    monkeypatch.setattr("firecrawl.v2.client.crawl_module.wait_for_crawl_completion", fake_wait)

    client.wait_crawl("job-id", raise_on_failure=raise_on_failure)

    assert received["raise_on_failure"] is raise_on_failure


@pytest.mark.parametrize("raise_on_failure", [False, True])
def test_public_batch_scrape_forwards_raise_on_failure(monkeypatch, raise_on_failure):
    client = FirecrawlClient(api_key="test")
    received = {}

    def fake_batch_scrape(http_client, urls, **kwargs):
        received.update(kwargs)
        return BatchScrapeJob(status="completed", completed=1, total=1, data=[])

    monkeypatch.setattr("firecrawl.v2.client.batch_module.batch_scrape", fake_batch_scrape)

    client.batch_scrape(["https://example.com"], raise_on_failure=raise_on_failure)

    assert received["raise_on_failure"] is raise_on_failure
