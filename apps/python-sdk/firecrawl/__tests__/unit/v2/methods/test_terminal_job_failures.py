from types import SimpleNamespace

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.methods import batch, crawl
from firecrawl.v2.types import BatchScrapeJob, CrawlJob, Document
from firecrawl.v2.utils import BatchScrapeJobFailedError, CrawlJobFailedError, FirecrawlError


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_wait_for_batch_completion_can_raise_on_non_success_terminal_status(monkeypatch, status):
    job = BatchScrapeJob(status=status, completed=0, total=2, data=[])
    monkeypatch.setattr(batch, "get_batch_scrape_status", lambda *args, **kwargs: job)

    # Backward-compatible default: return the terminal job.
    assert batch.wait_for_batch_completion(None, "job-id") is job

    with pytest.raises(BatchScrapeJobFailedError) as exc_info:
        batch.wait_for_batch_completion(None, "job-id", raise_on_failure=True)

    assert exc_info.value.job is job
    assert exc_info.value.status == status


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


@pytest.mark.parametrize("status", ["failed", "cancelled", "completed"])
@pytest.mark.parametrize("raise_on_failure", [False, True])
def test_public_crawl_handles_terminal_statuses(monkeypatch, status, raise_on_failure):
    client = FirecrawlClient(api_key="test")
    partial_document = Document(markdown="partial result")
    started_job = CrawlJob(id="job-id", status="scraping", completed=0, total=2, data=[])
    terminal_job = CrawlJob(
        id="job-id",
        status=status,
        completed=1,
        total=2,
        data=[partial_document],
    )
    monkeypatch.setattr(crawl, "start_crawl", lambda *args, **kwargs: started_job)
    monkeypatch.setattr(crawl, "get_crawl_status", lambda *args, **kwargs: terminal_job)

    if status in ["failed", "cancelled"] and raise_on_failure:
        with pytest.raises(CrawlJobFailedError) as exc_info:
            client.crawl("https://example.com", raise_on_failure=True)
        assert exc_info.value.job is terminal_job
        assert exc_info.value.job.data == [partial_document]
    else:
        assert client.crawl(
            "https://example.com",
            raise_on_failure=raise_on_failure,
        ) is terminal_job


@pytest.mark.parametrize("status", ["failed", "cancelled", "completed"])
@pytest.mark.parametrize("raise_on_failure", [False, True])
def test_public_wait_crawl_handles_terminal_statuses(monkeypatch, status, raise_on_failure):
    client = FirecrawlClient(api_key="test")
    job = CrawlJob(id="job-id", status=status, completed=1, total=2, data=[])
    monkeypatch.setattr(crawl, "get_crawl_status", lambda *args, **kwargs: job)

    if status in ["failed", "cancelled"] and raise_on_failure:
        with pytest.raises(CrawlJobFailedError):
            client.wait_crawl("job-id", raise_on_failure=True)
    else:
        assert client.wait_crawl(
            "job-id",
            raise_on_failure=raise_on_failure,
        ) is job


@pytest.mark.parametrize("status", ["failed", "cancelled", "completed"])
@pytest.mark.parametrize("raise_on_failure", [False, True])
def test_public_batch_scrape_handles_terminal_statuses(monkeypatch, status, raise_on_failure):
    client = FirecrawlClient(api_key="test")
    started_job = SimpleNamespace(id="job-id")
    terminal_job = BatchScrapeJob(
        status=status,
        completed=1,
        total=2,
        data=[Document(markdown="partial result")],
    )
    monkeypatch.setattr(batch, "start_batch_scrape", lambda *args, **kwargs: started_job)
    monkeypatch.setattr(batch, "get_batch_scrape_status", lambda *args, **kwargs: terminal_job)

    if status in ["failed", "cancelled"] and raise_on_failure:
        with pytest.raises(BatchScrapeJobFailedError) as exc_info:
            client.batch_scrape(["https://example.com"], raise_on_failure=True)
        assert exc_info.value.job is terminal_job
        assert exc_info.value.job.data == terminal_job.data
    else:
        assert client.batch_scrape(
            ["https://example.com"],
            raise_on_failure=raise_on_failure,
        ) is terminal_job
